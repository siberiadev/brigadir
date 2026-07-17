import dagre from '@dagrejs/dagre';
import type { AgentResponse, StatusesResponse } from '@brigadir/contracts';

/**
 * Feature 018 — pure derivation of the pipeline diagram from the two live
 * queries (agents whole-list + board statuses). No persistence anywhere: the
 * graph is recomputed on every data change and positions are assigned fresh by
 * `layoutGraph` (spec: derived state, nothing stored).
 *
 * Status nodes are keyed by NAME — agents bind to statuses by name
 * (trigger_status/status_success/status_failure), which also dedupes convergent
 * edges onto one node (FR-007). `status_running` is deliberately NOT an edge
 * and does not count as "referenced" (research R5) — it is a transient parking
 * state, not a pipeline transition.
 */

export type BoardStatus = StatusesResponse['statuses'][number];

export type StatusNodeKind = 'normal' | 'muted' | 'missing';

export interface StatusNodeData {
  name: string;
  kind: StatusNodeKind;
  /** Absent for 'missing' nodes — they exist only in agent config, not on the board. */
  statusCategory?: BoardStatus['statusCategory'];
}

export interface AgentNodeData {
  /** Full row: the node shows name/role, the edit intent needs the whole agent. */
  agent: AgentResponse;
  /** Non-null ⇒ render the JQL badge (tooltip carries this raw text). */
  jql: string | null;
}

export interface XYPosition {
  x: number;
  y: number;
}

export type DiagramNode =
  | { id: string; type: 'status'; data: StatusNodeData; position: XYPosition }
  | { id: string; type: 'agent'; data: AgentNodeData; position: XYPosition };

export type EdgeKind = 'trigger' | 'success' | 'failure';

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface GraphModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** 0 ⇒ the canvas shows the empty-state hint over the muted statuses. */
  visibleAgentCount: number;
}

export function statusNodeId(name: string): string {
  return `status:${name}`;
}

export function agentNodeId(agentId: string): string {
  return `agent:${agentId}`;
}

const ORIGIN: XYPosition = { x: 0, y: 0 };

export function buildGraph(
  agents: readonly AgentResponse[],
  statuses: readonly BoardStatus[],
): GraphModel {
  // Visibility (FR-010/011): the orchestrator and disabled agents contribute
  // nothing — no nodes, no edges, no "referenced" marks.
  const visible = agents.filter((a) => !a.is_orchestrator && a.enabled);

  // Statuses referenced through pipeline edges only (NOT status_running — R5).
  const referenced = new Set<string>();
  for (const a of visible) {
    if (a.trigger_status) referenced.add(a.trigger_status);
    referenced.add(a.status_success);
    referenced.add(a.status_failure);
  }

  const onBoard = new Set(statuses.map((s) => s.name));

  // Board statuses in board order, then missing (referenced ∧ ¬on board) in
  // first-reference order — a stable, deterministic node list (rule 6).
  const statusNodes: DiagramNode[] = statuses.map((s) => ({
    id: statusNodeId(s.name),
    type: 'status',
    data: {
      name: s.name,
      kind: referenced.has(s.name) ? 'normal' : 'muted',
      statusCategory: s.statusCategory,
    },
    position: ORIGIN,
  }));
  for (const name of referenced) {
    if (!onBoard.has(name)) {
      statusNodes.push({
        id: statusNodeId(name),
        type: 'status',
        data: { name, kind: 'missing' },
        position: ORIGIN,
      });
    }
  }

  const agentNodes: DiagramNode[] = visible.map((a) => ({
    id: agentNodeId(a.id),
    type: 'agent',
    data: { agent: a, jql: a.trigger_jql },
    position: ORIGIN,
  }));

  const edges: DiagramEdge[] = [];
  for (const a of visible) {
    if (a.trigger_status) {
      edges.push({
        id: `trigger:${a.id}`,
        source: statusNodeId(a.trigger_status),
        target: agentNodeId(a.id),
        kind: 'trigger',
      });
    }
    edges.push({
      id: `success:${a.id}`,
      source: agentNodeId(a.id),
      target: statusNodeId(a.status_success),
      kind: 'success',
    });
    edges.push({
      id: `failure:${a.id}`,
      source: agentNodeId(a.id),
      target: statusNodeId(a.status_failure),
      kind: 'failure',
    });
  }

  return { nodes: [...statusNodes, ...agentNodes], edges, visibleAgentCount: visible.length };
}

// Fixed dimensions fed to dagre — the node SFCs size themselves to match
// closely enough for a readable layered layout (research R1).
const NODE_SIZE = {
  agent: { width: 200, height: 84 },
  status: { width: 160, height: 56 },
} as const;

/**
 * Left-to-right layered layout. Dagre tolerates cycles (heuristic edge
 * reversal), so the pipeline may loop freely (FR-009). Returns a new model —
 * the input is not mutated.
 */
export function layoutGraph(model: GraphModel): GraphModel {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 72, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of model.nodes) g.setNode(n.id, { ...NODE_SIZE[n.type] });
  for (const e of model.edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const nodes = model.nodes.map((n) => {
    const laid = g.node(n.id);
    const size = NODE_SIZE[n.type];
    // dagre positions are node centers; Vue Flow expects top-left corners.
    return { ...n, position: { x: laid.x - size.width / 2, y: laid.y - size.height / 2 } };
  });

  return { ...model, nodes };
}

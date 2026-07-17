import { describe, it, expect } from 'vitest';
import type { AgentResponse } from '@brigadir/contracts';
import { sampleAgent, sampleStatuses } from './handlers';
import {
  buildGraph,
  layoutGraph,
  statusNodeId,
  agentNodeId,
} from '../src/components/AgentsDiagram/buildGraph';

/**
 * Feature 018 (US1) — the pure graph derivation. Every normative rule from the
 * spec (visibility, edge kinds, muted/missing statuses, cycle tolerance,
 * determinism) is asserted HERE, against plain data — the canvas is never
 * mounted (research R3).
 */

const statuses = sampleStatuses.statuses;

let seq = 0;
function makeAgent(overrides: Partial<AgentResponse>): AgentResponse {
  seq += 1;
  return { ...sampleAgent, id: `ag-t${seq}`, name: `Agent ${seq}`, key: `agent-${seq}`, ...overrides };
}

// sampleAgent: trigger 'Ready for Dev', running 'In Progress', success 'In Review', failure 'Blocked'.
const plain = () => makeAgent({});

describe('buildGraph — nodes & visibility', () => {
  it('renders one node per board status plus one per visible agent', () => {
    const a = plain();
    const g = buildGraph([a], statuses);

    const statusIds = g.nodes.filter((n) => n.type === 'status').map((n) => n.id);
    expect(statusIds).toEqual(statuses.map((s) => statusNodeId(s.name)));
    expect(g.nodes.filter((n) => n.type === 'agent').map((n) => n.id)).toEqual([agentNodeId(a.id)]);
    expect(g.visibleAgentCount).toBe(1);
  });

  it('hides the orchestrator entirely — no node, no edges, no "referenced" marks (FR-010)', () => {
    const orch = makeAgent({ is_orchestrator: true });
    const g = buildGraph([orch], statuses);

    expect(g.nodes.some((n) => n.type === 'agent')).toBe(false);
    expect(g.edges).toEqual([]);
    expect(g.visibleAgentCount).toBe(0);
    // Its trigger/success/failure statuses stay unreferenced → muted.
    for (const n of g.nodes) {
      expect(n.type === 'status' && n.data.kind).toBe('muted');
    }
  });

  it('hides disabled agents and all their edges (FR-011)', () => {
    const off = makeAgent({ enabled: false });
    const g = buildGraph([off, plain()], statuses);

    expect(g.nodes.filter((n) => n.type === 'agent')).toHaveLength(1);
    expect(g.edges.every((e) => !e.id.endsWith(off.id))).toBe(true);
    expect(g.visibleAgentCount).toBe(1);
  });

  it('empty roster → only muted status nodes and visibleAgentCount 0', () => {
    const g = buildGraph([], statuses);
    expect(g.visibleAgentCount).toBe(0);
    expect(g.edges).toEqual([]);
    expect(g.nodes.map((n) => n.type)).toEqual(statuses.map(() => 'status'));
    for (const n of g.nodes) expect(n.type === 'status' && n.data.kind).toBe('muted');
  });
});

describe('buildGraph — edges', () => {
  it('derives success + failure outcome edges and the trigger edge per visible agent (FR-005/006)', () => {
    const a = plain();
    const g = buildGraph([a], statuses);

    expect(g.edges).toHaveLength(3);
    const byKind = Object.fromEntries(g.edges.map((e) => [e.kind, e]));
    expect(byKind.trigger).toMatchObject({
      source: statusNodeId('Ready for Dev'),
      target: agentNodeId(a.id),
    });
    expect(byKind.success).toMatchObject({
      source: agentNodeId(a.id),
      target: statusNodeId('In Review'),
    });
    expect(byKind.failure).toMatchObject({
      source: agentNodeId(a.id),
      target: statusNodeId('Blocked'),
    });
  });

  it('convergent references share exactly one status node (FR-007)', () => {
    const a = makeAgent({ status_success: 'Done' });
    const b = makeAgent({ status_failure: 'Done', trigger_status: 'In Review' });
    const g = buildGraph([a, b], statuses);

    expect(g.nodes.filter((n) => n.id === statusNodeId('Done'))).toHaveLength(1);
    const toDone = g.edges.filter((e) => e.target === statusNodeId('Done'));
    expect(toDone.map((e) => e.kind).sort()).toEqual(['failure', 'success']);
  });

  it('an agent whose success and failure point at the same status yields two distinct edges', () => {
    const a = makeAgent({ status_success: 'Done', status_failure: 'Done' });
    const g = buildGraph([a], statuses);
    const outcome = g.edges.filter((e) => e.source === agentNodeId(a.id));
    expect(outcome).toHaveLength(2);
    expect(new Set(outcome.map((e) => e.id)).size).toBe(2);
  });

  it('JQL-only agent: no incoming trigger edge, jql carried on node data (FR-008)', () => {
    const a = makeAgent({ trigger_status: null, trigger_jql: 'labels = hotfix' });
    const g = buildGraph([a], statuses);

    expect(g.edges.some((e) => e.kind === 'trigger')).toBe(false);
    const node = g.nodes.find((n) => n.id === agentNodeId(a.id));
    expect(node?.type === 'agent' && node.data.jql).toBe('labels = hotfix');
  });

  it('trigger_status + trigger_jql together: trigger edge AND jql both present (FR-008)', () => {
    const a = makeAgent({ trigger_jql: 'priority = High' });
    const g = buildGraph([a], statuses);

    expect(g.edges.filter((e) => e.kind === 'trigger')).toHaveLength(1);
    const node = g.nodes.find((n) => n.id === agentNodeId(a.id));
    expect(node?.type === 'agent' && node.data.jql).toBe('priority = High');
  });
});

describe('buildGraph — status kinds', () => {
  it('board statuses referenced by no visible agent are muted (FR-012)', () => {
    const g = buildGraph([plain()], statuses);
    const kind = (name: string) => {
      const n = g.nodes.find((x) => x.id === statusNodeId(name));
      return n?.type === 'status' ? n.data.kind : undefined;
    };
    expect(kind('Ready for Dev')).toBe('normal');
    expect(kind('In Review')).toBe('normal');
    expect(kind('Blocked')).toBe('normal');
    expect(kind('Done')).toBe('muted');
  });

  it('status_running NEVER counts as referenced (research R5)', () => {
    // sampleAgent parks tickets in 'In Progress' while running — still muted.
    const g = buildGraph([plain()], statuses);
    const n = g.nodes.find((x) => x.id === statusNodeId('In Progress'));
    expect(n?.type === 'status' && n.data.kind).toBe('muted');
  });

  it('a referenced status absent from the board renders as a missing node with the edge kept (FR-013)', () => {
    const a = makeAgent({ status_success: 'Shipped' }); // not on the board
    const g = buildGraph([a], statuses);

    const n = g.nodes.find((x) => x.id === statusNodeId('Shipped'));
    expect(n?.type === 'status' && n.data.kind).toBe('missing');
    expect(
      g.edges.some((e) => e.kind === 'success' && e.target === statusNodeId('Shipped')),
    ).toBe(true);
  });

  it('empty statuses list with agents: every referenced status becomes a missing node (edge case)', () => {
    const a = plain();
    const g = buildGraph([a], []);

    expect(g.visibleAgentCount).toBe(1);
    expect(g.edges).toHaveLength(3);
    const statusNodes = g.nodes.filter((n) => n.type === 'status');
    expect(statusNodes.map((n) => n.data.kind)).toEqual(['missing', 'missing', 'missing']);
  });
});

describe('buildGraph — cycles & determinism', () => {
  it('tolerates cycles between agents (FR-009)', () => {
    const a = makeAgent({ trigger_status: 'Ready for Dev', status_success: 'In Review', status_failure: 'Blocked' });
    const b = makeAgent({ trigger_status: 'In Review', status_success: 'Done', status_failure: 'Ready for Dev' });
    const g = buildGraph([a, b], statuses);

    expect(g.visibleAgentCount).toBe(2);
    expect(g.edges).toHaveLength(6);
    // b's failure feeds a's trigger status — the cycle-closing edge exists.
    expect(
      g.edges.some((e) => e.kind === 'failure' && e.target === statusNodeId('Ready for Dev')),
    ).toBe(true);
  });

  it('tolerates a self-loop (trigger status equals success status)', () => {
    const a = makeAgent({ trigger_status: 'In Review', status_success: 'In Review' });
    const g = buildGraph([a], statuses);

    expect(g.edges.filter((e) => e.kind === 'trigger')).toHaveLength(1);
    expect(
      g.edges.some((e) => e.kind === 'success' && e.target === statusNodeId('In Review')),
    ).toBe(true);
  });

  it('is deterministic: board order first, then missing in first-reference order, then agents in roster order', () => {
    const a = makeAgent({ status_success: 'Shipped' });
    const b = makeAgent({ status_failure: 'Archived' });
    const g1 = buildGraph([a, b], statuses);
    const g2 = buildGraph([a, b], statuses);

    expect(g1).toEqual(g2);
    expect(g1.nodes.map((n) => n.id)).toEqual([
      ...statuses.map((s) => statusNodeId(s.name)),
      statusNodeId('Shipped'),
      statusNodeId('Archived'),
      agentNodeId(a.id),
      agentNodeId(b.id),
    ]);
  });
});

describe('layoutGraph', () => {
  it('assigns finite positions to every node, including cyclic graphs', () => {
    const a = makeAgent({ trigger_status: 'Ready for Dev', status_success: 'In Review' });
    const b = makeAgent({ trigger_status: 'In Review', status_failure: 'Ready for Dev' });
    const laid = layoutGraph(buildGraph([a, b], statuses));

    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it('lays a simple chain out left-to-right: trigger status before agent before success status', () => {
    const a = makeAgent({ trigger_status: 'Ready for Dev', status_success: 'Done', status_failure: 'Blocked' });
    const laid = layoutGraph(buildGraph([a], statuses));

    const x = (id: string) => laid.nodes.find((n) => n.id === id)!.position.x;
    expect(x(statusNodeId('Ready for Dev'))).toBeLessThan(x(agentNodeId(a.id)));
    expect(x(agentNodeId(a.id))).toBeLessThan(x(statusNodeId('Done')));
  });
});

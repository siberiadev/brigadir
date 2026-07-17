# Data Model: Agents Diagram View Mode

**Feature**: 018-agents-diagram-view | **Date**: 2026-07-17

No persistent entities — this feature adds **zero** database tables, columns, or API payloads. The model below is the client-side **view model** produced by `buildGraph.ts` (a pure function) and consumed by the Vue Flow canvas. Source types are the existing contracts: `AgentResponse` and `BoardStatus` (`packages/contracts/src/dashboard.schema.ts`) — both unchanged.

## Inputs

| Input | Source | Notes |
|---|---|---|
| `agents: AgentResponse[]` | `useAgents(wsId, { page: 1, page_size: MAX_PAGE_SIZE })` → `.items` | Whole-list convention; roster capped at 20 so one page always suffices |
| `statuses: BoardStatus[]` | `useStatuses(wsId)` → `.statuses` | Live board snapshot `{ id, name, statusCategory }` |

## Derived types (new, in `apps/web/src/components/AgentsDiagram/buildGraph.ts`)

```ts
type StatusNodeKind = 'normal' | 'muted' | 'missing';

interface StatusNodeData {
  name: string;               // canonical key — agents bind by name
  kind: StatusNodeKind;
  statusCategory?: BoardStatus['statusCategory']; // absent for 'missing' nodes
}

interface AgentNodeData {
  agent: AgentResponse;       // full row — node needs name/role for display, whole row for edit intent
  jql: string | null;         // trigger_jql; non-null ⇒ render JQL badge with tooltip
}

type DiagramNode =
  | { id: `status:${string}`; type: 'status'; data: StatusNodeData; position: XYPosition }
  | { id: `agent:${string}`;  type: 'agent';  data: AgentNodeData;  position: XYPosition };

type EdgeKind = 'trigger' | 'success' | 'failure';

interface DiagramEdge {
  id: `${EdgeKind}:${string}`;   // suffixed with agent id → globally unique
  source: string;                // node id
  target: string;                // node id
  kind: EdgeKind;                // drives styling (solid/primary, solid/success, dashed/danger)
}

interface GraphModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  visibleAgentCount: number;     // 0 ⇒ canvas shows the empty-state hint
}
```

(Positions are assigned by the dagre layout step; `buildGraph` itself emits position-less nodes and the layout wrapper fills them — semantics tests assert on `buildGraph` output only.)

## Derivation rules (normative — each maps to a spec FR)

1. **Agent visibility** (FR-010, FR-011): an agent yields a node iff `!is_orchestrator && enabled`. Invisible agents contribute *nothing* — no nodes, no edges, no "referenced" marks.
2. **Status nodes** (FR-004, FR-007, FR-012, FR-013): one node per distinct name in (live board statuses) ∪ (statuses referenced by visible agents via `trigger_status` / `status_success` / `status_failure`). `kind` resolution:
   - referenced ∧ on board → `'normal'`
   - ¬referenced ∧ on board → `'muted'`
   - referenced ∧ ¬on board → `'missing'`
   - `status_running` **never** counts as "referenced" (decision R5).
3. **Outcome edges** (FR-005): per visible agent, exactly two — `success: agent → status(status_success)` and `failure: agent → status(status_failure)`. Both fields are NOT NULL on worker agents; if the same status is both success and failure target, two distinct edges converge on one node.
4. **Trigger edge** (FR-006, FR-008): per visible agent with non-null `trigger_status`, one `trigger: status(trigger_status) → agent`. JQL-only agents (null `trigger_status`) get no incoming edge; `jql` is set on `AgentNodeData` whenever `trigger_jql` is non-null (badge also shows alongside a trigger edge).
5. **Cycle/self-loop tolerance** (FR-009): derivation is a flat map — no reachability walk, no topological assumptions; cycles and self-loops (trigger status = success status) are just edges. Layout (dagre) handles cyclic graphs by heuristic edge reversal; correctness of *data* never depends on acyclicity.
6. **Determinism**: output order is stable (statuses in board order, then missing statuses in first-reference order; agents in list order) so snapshots/tests don't flake and dagre layout is reproducible for identical inputs.

## State (component-local, never persisted)

| State | Home | Lifetime |
|---|---|---|
| `mode: 'list' \| 'diagram'` | `AgentsList.vue` ref, default `'list'` | Dies on route leave (FR-002) |
| `createTriggerStatus: string \| null` | `AgentsList.vue` ref | Set by diagram `create-agent` intent; cleared on dialog close |
| Node drag positions, viewport pan/zoom | Vue Flow internal state | Discarded on graph recompute / unmount (FR-014) |

## Existing entities touched

None. `AgentResponse`, `AgentWriteRequest`, `BoardStatus`, all query keys, and all endpoints are used strictly as-is.

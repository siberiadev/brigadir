# Component Contracts: Agents Diagram View Mode

**Feature**: 018-agents-diagram-view | **Date**: 2026-07-17

No HTTP contracts change — the feature consumes `GET /api/agents?workspace_id=…&page=1&page_size=100` and `GET /api/workspaces/:id/statuses` exactly as shipped. The contracts below are the **component interfaces** inside `apps/web` (this project's external-interface equivalent for a UI-only feature), plus the one shared-form contract extension.

## 1. `buildGraph` (pure function — the tested semantic core)

```ts
// apps/web/src/components/AgentsDiagram/buildGraph.ts
export function buildGraph(
  agents: readonly AgentResponse[],
  statuses: readonly BoardStatus[],
): GraphModel;
```

- Total function: never throws on any roster/status combination (empty lists, cycles, self-loops, stale references, duplicate outcome targets).
- Deterministic: identical inputs → identical output (stable ordering — see data-model rule 6).
- Side-effect free; suitable for direct use inside a Vue `computed`.
- Contract tests: `apps/web/test/agents-diagram-graph.spec.ts` (visibility rules, edge derivation, kind resolution, cycle tolerance — spec SC-006).

## 2. `<AgentsDiagram>` (canvas component)

```ts
// apps/web/src/components/AgentsDiagram/AgentsDiagram.vue
defineProps<{
  agents: AgentResponse[];        // whole-list items (parent owns the query)
  statuses: BoardStatus[];        // live board statuses (parent owns the query)
  loading?: boolean;              // either source query pending → v-loading treatment
  error?: boolean;                // either source query errored → error state, no partial graph
}>();

defineEmits<{
  'create-agent': [statusName: string]; // "+" on a status node
  'edit-agent': [agent: AgentResponse]; // edit button on an agent node
}>();
```

- Dumb component: receives data, renders graph, emits intents. It runs **no queries and no mutations** — the parent (`AgentsList.vue`) owns data and dialogs. This keeps FR-003/SC-005 (no refetch on toggle) structurally true and makes the component testable with plain props.
- Internally: `computed(() => layout(buildGraph(props.agents, props.statuses)))` → `<VueFlow>` with custom node types `status` → `StatusNode.vue`, `agent` → `AgentNode.vue`.
- Empty state (`visibleAgentCount === 0`): renders muted statuses + `el-empty` hint (FR-018).

### 2a. `<StatusNode>` / `<AgentNode>` (Vue Flow node renderers)

- Receive Vue Flow's node props (`data` typed as `StatusNodeData` / `AgentNodeData`).
- `StatusNode`: displays name; `kind` drives normal/muted/missing styling; "+" button (every status node — spec assumption) emits the create intent upward (via Vue Flow node event → `AgentsDiagram` re-emit).
- `AgentNode`: displays name + role tag; edit button emits edit intent; `data.jql !== null` → "JQL" `el-tag` inside an `el-tooltip` whose content is the raw JQL string.
- `data-test` hooks (for interaction tests): `diagram-status-node`, `status-add-agent`, `diagram-agent-node`, `agent-edit`, `agent-jql-badge`, plus `view-mode-toggle` on the segmented control in `AgentsList.vue`.

## 3. `AgentForm` contract extension (the only shared-component change)

```ts
// apps/web/src/components/AgentForm/AgentForm.vue — props BEFORE:
defineProps<{ workspaceId: string; agent?: AgentResponse | null; repositories: WorkspaceRepository[] }>();
// AFTER (additive, optional — all existing call sites remain valid):
defineProps<{
  workspaceId: string;
  agent?: AgentResponse | null;
  repositories: WorkspaceRepository[];
  /** Create mode only: seeds form.trigger_status; ignored when `agent` is set. */
  initialTriggerStatus?: string;
}>();
```

- Seed-only semantics: `trigger_status: a?.trigger_status ?? props.initialTriggerStatus ?? ''` in the initial `reactive` — the user can change it; every other behavior (client lint mirror, server-authoritative 422 re-pinning, warnings passthrough, `status_ids` mapping) is byte-for-byte unchanged (FR-015).
- `AgentsList.vue` must extend the remount key so consecutive prefills re-seed: `:key="editing?.id ?? \`new:${createTriggerStatus ?? ''}\`"`.

## 4. `AgentsList.vue` view contract (mode host)

- Owns `mode` ref (`'list'` default, not persisted), the `el-segmented` toggle, and the single `FormDialog`+`AgentForm` used by **both** modes.
- Diagram data: adds `useAgents(props.id, { page: 1, page_size: MAX_PAGE_SIZE })` (cache-shared with AgentForm's identical key) and `useStatuses(props.id)`; the paginated list query is untouched.
- Wiring: `@create-agent="(s) => { createTriggerStatus = s; openCreate(); }"`, `@edit-agent="openEdit"` — reusing the existing handlers; save/invalidate path unchanged (FR-017 via existing `useCreateAgent`/`useUpdateAgent` invalidation of the `['agents', wsId]` prefix).

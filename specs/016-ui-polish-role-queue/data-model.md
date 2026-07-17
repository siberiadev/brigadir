# Data Model: UI polish — agent role & executor visibility, human queue ordering

**Feature**: 016-ui-polish-role-queue | **Date**: 2026-07-17

**No database schema changes, no migrations, no contract (zod) schema changes.** This feature only reads fields that already exist and reorders one query. The entities below document what is consumed and how, with the authoritative source for each.

## Entities (read-only views)

### Run (list item) — consumed by Runs.vue

Source of truth: `packages/contracts/src/runs.schema.ts` → `RunListItemSchema`; delivered by the workspace runs list endpoint.

| Field used | Type | New usage in this feature |
|---|---|---|
| `agent` | `RunAgentRef` (below) | Already rendered (`agent.name`); now also `agent.role` |
| all other fields | — | Unchanged |

### RunAgentRef — embedded agent reference on a run

Source: `RunAgentRefSchema` (`runs.schema.ts` L34-36): `{ id: string, name: string, key: string, role: string | null }`.

- **Display rule (new)**: Runs list "Role" column shows `role`; when `role` is `null`, missing, or `''` → em dash `—`. When the whole `agent` reference is absent → same em dash.

### HumanTask (queue item) — consumed by HumanQueue.vue

Source: `packages/contracts/src/human-queue.schema.ts` → `HumanQueueItemSchema`. Shape unchanged.

| Field | Role in this feature |
|---|---|
| `created_at` | Primary sort key of OPEN tab — **direction flips to DESC (newest first)** |
| `id` | New secondary sort key (unique tie-breaker) on both tabs |
| `status`, `resolution`, `resolved_by`, `resolved_at` | Closed-tab-only fields; `resolved_at DESC` primary ordering unchanged |

- **Ordering rule (new)**:
  - OPEN (`?status=open`, default): `ORDER BY created_at DESC, id DESC`
  - CLOSED (`?status=closed`): `ORDER BY resolved_at DESC, id DESC` (primary key direction unchanged; `id` tie-breaker added for determinism)
- Applies identically with and without the `?workspace=` filter (global page and workspace tab share the endpoint).

### Agent (list item) — consumed by AgentsList.vue

Source: `packages/contracts/src/dashboard.schema.ts` → `AgentResponseSchema`. Shape unchanged.

| Field used | Type | New usage |
|---|---|---|
| `name` | `string` | Name column shows this **alone** (the "(role)" suffix is removed) |
| `role` | `string \| null` | New "Role" column, rendered as a tag; `null`/`''` → empty cell |
| `key` | `string` | Key column — unchanged |
| `executor_id` | `string` | New "Executor" column input — never displayed raw; resolved to a name via the Executor lookup |

### Executor profile — lookup source for the Executor column

Source: `packages/contracts/src/executor.schema.ts` → `ExecutorResponseSchema`: `{ id, type, name, enabled, max_parallel_runs, has_api_key, config }`. Platform-scoped, few instances.

- **Lookup rule (new)**: frontend builds `Map<id, name>` from the executors list (fetched via existing `useExecutors`, whole-list `page_size = MAX_PAGE_SIZE`). `agent.executor_id → map.get(...)`:
  - hit → display executor `name`
  - miss / list not yet loaded / list fetch failed → empty cell; table renders normally

## Relationships

```text
Run ──(embedded ref)──> RunAgentRef.role                    [runs list Role column]
HumanTask.created_at / .id                                  [OPEN tab ordering]
HumanTask.resolved_at / .id                                 [History tab ordering, primary unchanged]
Agent.executor_id ──(client-side Map lookup)──> Executor.name   [Agents page Executor column]
Agent.role                                                  [Agents page Role tag column]
```

## Validation rules

- Empty-string `role` is treated identically to `null` (spec assumption): both fallbacks (`—` in runs, empty cell in agents) trigger on falsy role.
- No new validation is added to any schema; all rules above are presentation/ordering rules.

## State transitions

None — no entity changes state in this feature.

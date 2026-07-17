# Contract Delta: GET /api/human-tasks — result ordering

**Feature**: 016-ui-polish-role-queue | **Date**: 2026-07-17

This is the **only** externally observable API behavior change in the feature. No request parameters, response schemas, status codes, or auth change anywhere. `RunListItem`, `AgentResponse`, `HumanQueueItem`, `ExecutorResponse` zod schemas in `packages/contracts` are byte-identical before and after.

## Endpoint

`GET /api/human-tasks` (dashboard-token auth; paginated envelope `{ items, page, page_size, total }` via `makePaginatedResponseSchema` — all unchanged)

Query params (unchanged): `status=open|closed` (default `open`), `workspace=<id>` (optional scope), `page`, `page_size`.

## Ordering contract

| Branch | Before | After |
|---|---|---|
| `status=open` | `ORDER BY created_at ASC` (oldest-first, "longest-waiting on top") | `ORDER BY created_at DESC, id DESC` (**newest-first**, most recently created on top) |
| `status=closed` | `ORDER BY resolved_at DESC` | `ORDER BY resolved_at DESC, id DESC` (primary ordering unchanged; unique tie-breaker added) |

Guarantees:

1. **Newest-first open tab**: for any two open tasks A and B with `A.created_at > B.created_at`, A precedes B in the flattened paginated sequence.
2. **Determinism**: the full `ORDER BY` key (`created_at, id` / `resolved_at, id`) is unique per row; identical requests return identical sequences, and paging never duplicates or skips a row for a fixed dataset (project-wide deterministic-ORDER-BY rule for paginated endpoints).
3. **Scope-invariance**: ordering is identical with and without `workspace=` — the global /human-queue page and the workspace Human queue tab (same endpoint, same component) can never disagree.
4. **History semantics preserved**: closed tab remains most-recently-resolved-first; the added `id` tie-breaker only disambiguates equal `resolved_at` values.

## Consumer impact

- `apps/web` (`useHumanTasks` → `HumanQueue.vue`): no code change required to consume the new order; rows render in server order.
- `GET /api/human-tasks/count`: unchanged.

## Contract tests

- `test/integration/human-queue.spec.ts`: open-tab assertion flips from oldest-first to newest-first; new case with two tasks sharing `created_at` pins the `id DESC` tie-break; closed-tab test unchanged (still resolved_at DESC).

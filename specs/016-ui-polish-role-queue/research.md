# Research: UI polish — agent role & executor visibility, human queue ordering

**Feature**: 016-ui-polish-role-queue | **Date**: 2026-07-17

No `NEEDS CLARIFICATION` markers existed in the Technical Context; this phase records the codebase verification and the small design decisions that shape implementation.

## R1. Runs list already carries the agent role — frontend-only change confirmed

- **Decision**: Add the "Role" column purely in `apps/web/src/views/Runs.vue`; render `row.agent.role`, fall back to `—` when null/empty.
- **Rationale**: `RunAgentRefSchema` (`packages/contracts/src/runs.schema.ts` L34-36) is `{ id, name, key, role: string | null }` — the role is already serialized in every runs-list item and run card. The existing Cost column (`Runs.vue` L155-157) already uses the `?? '—'` em-dash fallback pattern; the Role column copies it. Confirms the spec assumption "no backend changes for item 1".
- **Alternatives considered**: Merging role into the Agent column as "Name (role)" — rejected: the Agents page is simultaneously moving *away* from that combined format (spec item 3); a separate column keeps both pages consistent.

## R2. Human queue OPEN ordering: `desc(created_at), desc(id)`

- **Decision**: In `HumanTasksController.list()` (`apps/backend/src/dashboard/human-tasks.controller.ts`), change the open branch from `.orderBy(schema.humanTasks.createdAt)` (L92-93, oldest-first) to `.orderBy(desc(schema.humanTasks.createdAt), desc(schema.humanTasks.id))`, and update the code comment (the current one says "oldest-first: longest-waiting on top"). Add `desc(schema.humanTasks.id)` as a secondary key to the closed branch (L87) as well.
- **Rationale**:
  - Both the global `/human-queue` page and the workspace Human queue tab render the same `HumanQueue.vue` view backed by the same `GET /api/human-tasks` endpoint (`useHumanTasks` composable), so one `ORDER BY` change covers both — exactly as the spec describes.
  - The project rule (CLAUDE.md, pagination convention) requires a deterministic `ORDER BY` on every paginated endpoint. `created_at` alone can tie (tasks created in the same transaction/millisecond); `id` (PK) is the canonical unique tie-breaker. This satisfies spec FR-003.
  - The closed branch currently orders by `resolved_at DESC` only — same latent nondeterminism. Adding the `id` tie-breaker does not change the user-visible primary ordering (FR-004 "History unchanged" still holds: most-recently-resolved first) while bringing the branch into compliance with the same project rule. `desc(id)` is chosen over `asc(id)` so both branches read uniformly; either is deterministic.
- **Alternatives considered**:
  - Client-side sorting in `HumanQueue.vue` — rejected: pagination is server-side; sorting only the fetched page would produce wrong global order across pages.
  - Leaving the closed branch untouched entirely — viable (spec only mandates open-tab change), but rejected because it leaves a known violation of the deterministic-ORDER-BY rule one line away from the code being edited; the tie-breaker is invisible to users.
  - Using `resolved_at` tie-break on open tab — nonsensical (null for open tasks).

## R3. Impacted existing tests (must flip, not just add)

- **Decision**: Update `test/integration/human-queue.spec.ts` L78-87 ("GET list open → oldest-first", asserts titles `['Which DB?', 'Newer']`) to expect newest-first (`['Newer', 'Which DB?']`), rename the test, and add a same-`created_at` fixture pair asserting stable id-ordered output. Web-side `apps/web/test/human-queue.spec.ts` gets an ordering-oriented assertion against MSW fixtures.
- **Rationale**: The old behavior is pinned by an existing integration test; if it is not updated in the same change, CI fails. The spec explicitly notes this is a deliberate reversal of the earlier decision, so the test rename should say "newest-first" to re-pin the new decision.
- **Alternatives considered**: None — mandatory.

## R4. Agents page Role column: `el-tag`, `size="small"`, default type

- **Decision**: In `AgentsList.vue`, the Name column template drops the `<span v-if="row.role" class="agent-role"> ({{ row.role }})</span>` suffix (L151-152); a new "Role" column renders `<el-tag v-if="row.role" size="small">{{ row.role }}</el-tag>` (empty cell otherwise). The `.agent-role` style becomes unused and is removed if nothing else references it.
- **Rationale**: `el-tag` inherits brand colors from the Element Plus theme variables (`--el-color-*`) automatically — no hardcoded colors, complying with the theming convention. Default (primary-tinted) tag type is used; role is not a status, so semantic types (success/warning/danger) would be misleading. `v-if` on the tag yields a genuinely empty cell for role-less agents, matching spec FR-005 ("no tag, no placeholder").
- **Alternatives considered**: Plain text role column — acceptable but the spec explicitly asks for a tag; per-role color mapping — rejected: roles are free-form strings (feature 014), no stable enum to map.

## R5. Executor column: resolve via `useExecutors` map, empty-cell fallback

- **Decision**: `AgentsList.vue` calls the existing `useExecutors({ page: 1, page_size: MAX_PAGE_SIZE })` (same pattern as `AgentForm.vue` L43) and builds a computed `Map<executor_id, name>`; the "Executor" column renders `executorName(row.executor_id)` or an empty cell (`v-if`) when the map has no entry or the query hasn't resolved yet.
- **Rationale**:
  - `AgentResponseSchema` carries only `executor_id` (`dashboard.schema.ts` L196); `ExecutorResponseSchema` (`executor.schema.ts` L91-102) carries `id` + `name`. Executors are platform-scoped and few (spec assumption), and the composable's TanStack cache key `['executors']` is global, so the lookup costs at most one cached request per page view.
  - Per the pagination convention, whole-list consumers (lookups by id) use `page_size=100` (`MAX_PAGE_SIZE`) rather than paging — exactly the sanctioned pattern already used by `AgentForm.vue`.
  - TanStack `useQuery` degrades gracefully: while loading or on error, `data` is undefined → map is empty → all Executor cells are empty and the table renders normally (spec FR-007). No error propagation or blocking needed.
- **Alternatives considered**:
  - Backend join: embed `executor_name` in `AgentResponseSchema` — rejected: contract change + backend change for data the frontend can already resolve from an existing cached endpoint; spec scopes items 3-4 as display-only.
  - Per-row `GET /api/executors/:id` — rejected: N requests where one cached list suffices.
  - Showing raw `executor_id` as fallback — explicitly forbidden by spec FR-006.

## R6. Test fixture strategy (web)

- **Decision**: Extend `apps/web/test/handlers.ts` fixtures: runs fixtures get agents with and without `role`; agents fixtures get `role` present/absent and distinct `executor_id`s; add/extend an MSW handler for `GET /api/executors` returning named profiles plus leave one agent's `executor_id` unmatched to exercise the fallback. New spec file `agents-columns.spec.ts` mounts `AgentsList.vue` via `mountWithProviders`; `runs-table.spec.ts` extended for the Role column.
- **Rationale**: Follows the established harness (Vitest + jsdom + @vue/test-utils + MSW, `mountWithProviders`/`flush()` from `test/mount.ts`); the existing `runs-table.spec.ts` demonstrates the exact pattern for asserting rendered `el-table` cells.
- **Alternatives considered**: Testing column logic as isolated functions — rejected: the risk is in template wiring (fallbacks, v-if emptiness), which only mount-level tests catch.

## Resolution status

All Technical Context items resolved; no open unknowns remain.

# Tasks: UI polish — agent role & executor visibility, human queue ordering

**Input**: Design documents from `/specs/016-ui-polish-role-queue/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/human-tasks-ordering.md, quickstart.md

**Tests**: Included — spec FR-009 mandates frontend tests for the new columns and ordering in the same change, and the ordering change is pinned by an existing integration test that must be flipped (constitution VI's UI-lighter-coverage clause applies, but the spec self-imposes tests).

**Organization**: Tasks are grouped by user story. US3 and US4 both edit `apps/web/src/views/AgentsList.vue` and share a new test file, so US4 tasks are sequenced after US3's (no [P] across those two stories).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = queue newest-first, US2 = runs Role column, US3 = agents Name/Role split, US4 = agents Executor column

## Path Conventions

pnpm monorepo (from plan.md): backend `apps/backend/src/`, web `apps/web/src/`, web tests `apps/web/test/`, integration tests `test/integration/`, contracts `packages/contracts/src/` (untouched).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Shared test fixtures consumed by the story-level web tests. No project scaffolding is needed — all files, endpoints, composables, and schemas already exist; **no contract or DB changes anywhere in this feature**.

- [X] T001 Extend shared MSW fixtures in apps/web/test/handlers.ts: give run-list fixtures agents both with `role` set and with `role: null`; give agent-list fixtures a mix of `role` present/absent and distinct `executor_id`s (one deliberately unmatched); add (or extend) a `GET /api/executors` handler returning a paginated envelope of named executor profiles whose `id`s match the matched agents' `executor_id`s. Keep existing fixture fields intact so current suites stay green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None required. Every story builds on already-shipped foundations (`RunAgentRefSchema.role`, `AgentResponseSchema.role`/`executor_id`, `useExecutors`, `useHumanTasks`, the shared pagination stack). Proceed directly to user stories.

**Checkpoint**: n/a — user story implementation can begin immediately after T001 (US1 does not even depend on T001).

---

## Phase 3: User Story 1 - Newest open human tasks appear on top (Priority: P1) 🎯 MVP

**Goal**: OPEN tab of the needs-human queue sorts newest-first (created_at DESC, id DESC) in both the global /human-queue page and every workspace's Human queue tab — one server-side ordering change; History tab keeps resolved_at DESC (gains only an invisible id tie-breaker for determinism).

**Independent Test**: Seed open tasks with distinct (and identical) `created_at` values; `GET /api/human-tasks?status=open` returns newest-first with stable tie-break, with and without `?workspace=`; closed list still newest-resolved-first. UI shows the same order in both locations.

### Tests for User Story 1 (write first, watch them fail) ⚠️

- [X] T002 [US1] Flip the integration expectation in test/integration/human-queue.spec.ts: rename "GET list open → oldest-first" (L78-87) to newest-first and reverse the expected title order (['Newer', 'Which DB?']); add a case with two open tasks sharing the same `created_at` asserting stable id-descending order across a paginated fetch (no duplicate/skip); verify the workspace-scoped describe (L139-209) assertions against the new order. Closed-tab test (resolved_at DESC) stays as-is. Run: `pnpm test:integration -- human-queue` — must FAIL against current code.
- [X] T003 [P] [US1] Extend apps/web/test/human-queue.spec.ts: assert `HumanQueue.vue` renders open-tab rows in the exact order the (MSW) server returns them — fixture ordered newest-first — for both the global mount and a mount with `workspaceId` prop.

### Implementation for User Story 1

- [X] T004 [US1] In apps/backend/src/dashboard/human-tasks.controller.ts change the open branch (L92-93) to `.orderBy(desc(schema.humanTasks.createdAt), desc(schema.humanTasks.id))` and replace the "oldest-first: longest-waiting on top" comment with the newest-first rationale; add `desc(schema.humanTasks.id)` as secondary key to the closed branch (L87). Import `desc` if not already imported (it is — used at L87).
- [X] T005 [US1] Verify: `pnpm test:integration -- human-queue` green; full `pnpm test` green (web queue suites unaffected except T003).

**Checkpoint**: Queue ordering behavior complete and pinned by tests — deliverable on its own.

---

## Phase 4: User Story 2 - Role column in the runs list (Priority: P2)

**Goal**: Workspace Runs tab shows a "Role" column with the run's agent role; em dash (—) when the agent has no role (or the reference is absent). Frontend-only — `row.agent.role` is already in the response.

**Independent Test**: Mount `Runs.vue` against fixtures containing runs whose agents have and lack roles; the Role column header exists, role text renders, and the fallback cell is `—`. All pre-existing columns unchanged.

### Tests for User Story 2 (write first) ⚠️

- [X] T006 [US2] Extend apps/web/test/runs-table.spec.ts (uses T001 fixtures): assert a "Role" column header is present, a row whose agent has a role shows it, and a row whose agent has `role: null` (and/or empty string) renders `—`; keep existing assertions (Agent, Ticket, Status, Cost, duration) untouched to pin no-regression.

### Implementation for User Story 2

- [X] T007 [US2] Add the "Role" column to apps/web/src/views/Runs.vue after the Agent column (L134-136): template rendering `row.agent?.role || '—'` (falsy role → em dash), mirroring the Cost column's fallback idiom (L155-157). No other column touched; no new icons; no hardcoded colors.

**Checkpoint**: Runs list enhancement complete and independently shippable.

---

## Phase 5: User Story 3 - Agents page Name/Role split (Priority: P3)

**Goal**: Agents tab Name column shows only the persona name (drop the `(role)` suffix); a new "Role" column renders the role in an `el-tag` (`size="small"`, default type — theme colors come from `--el-color-*` automatically); role-less agents get a genuinely empty cell. Key column untouched.

**Independent Test**: Mount `AgentsList.vue` with agents with/without roles; Name cells contain no parentheses, Role cells contain an el-tag with the role or nothing.

### Tests for User Story 3 (write first) ⚠️

- [X] T008 [US3] Create apps/web/test/agents-columns.spec.ts mounting `AgentsList.vue` via `mountWithProviders` (pattern: apps/web/test/runs-table.spec.ts): assert (a) a "Role" column header exists; (b) the Name cell for an agent with role "reviewer" is exactly the persona name — no " (reviewer)" suffix; (c) the Role cell contains an `.el-tag` with text "reviewer"; (d) a role-less agent's Role cell has no tag and no placeholder text; (e) the Key column still renders `[data-test="agent-key"]`.

### Implementation for User Story 3

- [X] T009 [US3] In apps/web/src/views/AgentsList.vue: remove the `<span v-if="row.role" class="agent-role"> ({{ row.role }})</span>` from the Name column (L151-152); insert a "Role" `el-table-column` between Name and Key rendering `<el-tag v-if="row.role" size="small">{{ row.role }}</el-tag>`; delete the now-unused `.agent-role` style block (L193-195) after grepping that nothing else uses the class.

**Checkpoint**: Agents page role presentation complete; US1/US2 unaffected.

---

## Phase 6: User Story 4 - Agents page Executor column (Priority: P3)

**Goal**: Agents tab shows an "Executor" column with the executor profile **name**, resolved client-side from the platform executors list; unresolvable (unknown id, list loading/failed) → empty cell; raw UUID never shown.

**Independent Test**: With the executors MSW handler active, agents whose `executor_id` matches a profile show its name; the agent with the unmatched `executor_id` shows an empty cell; the table renders fully either way.

### Tests for User Story 4 (write first) ⚠️

- [X] T010 [US4] Extend apps/web/test/agents-columns.spec.ts (after T008; same file — not parallel): assert (a) an "Executor" column header exists; (b) an agent whose `executor_id` matches a fixture executor shows that executor's `name` and the cell text does not contain the raw id; (c) the agent with the unmatched `executor_id` has an empty Executor cell while the rest of its row renders.

### Implementation for User Story 4

- [X] T011 [US4] In apps/web/src/views/AgentsList.vue (after T009; same file): import `useExecutors` and `MAX_PAGE_SIZE`, call `useExecutors({ page: 1, page_size: MAX_PAGE_SIZE })` (whole-list lookup pattern from apps/web/src/components/AgentForm/AgentForm.vue L43); build a computed `Map<string, string>` of executor id → name; add an "Executor" `el-table-column` rendering the mapped name via `v-if` (no entry / not loaded / fetch error → empty cell, table never blocks on the query).

**Checkpoint**: All four stories functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T012 Full validation per specs/016-ui-polish-role-queue/quickstart.md: `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration` all green; then manual browser spot-check of all four changes (runs Role column, both queue locations newest-first + History unchanged, agents Name/Role/Executor columns) against the running stack.
- [X] T013 Convention sweep of the diff: no hardcoded brand colors (only `--el-color-*` / theme-derived el-tag), no new `el-pagination` or pagination changes, no new animated icons, `packages/contracts` and `drizzle/` untouched.
- [X] T014 Append the iteration entry to docs/progress.md (journal convention from CLAUDE.md): note the deliberate reversal of the 2026-07 "oldest-first / longest-waiting on top" human-queue decision to newest-first, plus the new runs/agents columns.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: blocks web-test tasks T006, T008, T010 (fixtures). US1 does not depend on it.
- **Foundational**: none — empty phase.
- **US1 (Phase 3)**: independent of everything; can start immediately.
- **US2 (Phase 4)**: needs T001 only.
- **US3 (Phase 5)**: needs T001 only.
- **US4 (Phase 6)**: needs T001, and is sequenced after US3 (T008→T010 same test file, T009→T011 same component).
- **Polish (Phase 7)**: after all stories; T012 → T013/T014 order is free (T013, T014 can run in parallel with each other after T012).

### User Story Dependencies

- US1 (P1): none — pure backend + one web assertion.
- US2 (P2): none on other stories (T001 fixtures only).
- US3 (P3): none on other stories.
- US4 (P3): file-level dependency on US3 (shared `AgentsList.vue` + shared spec file) — implement after US3 to avoid same-file conflicts; still independently *testable* (its assertions stand alone).

### Within Each User Story

- Test task(s) first, confirmed failing → implementation → suite green (T002/T003 → T004 → T005; T006 → T007; T008 → T009; T010 → T011).

### Parallel Opportunities

- **Across stories**: after T001, US1 / US2 / US3(+US4) are three disjoint file sets — three developers (or three sequential work blocks) with zero conflicts:
  - Track A (US1): `test/integration/human-queue.spec.ts`, `apps/web/test/human-queue.spec.ts`, `apps/backend/src/dashboard/human-tasks.controller.ts`
  - Track B (US2): `apps/web/test/runs-table.spec.ts`, `apps/web/src/views/Runs.vue`
  - Track C (US3→US4): `apps/web/test/agents-columns.spec.ts`, `apps/web/src/views/AgentsList.vue`
- **Within US1**: T002 and T003 are different files → parallel ([P] on T003).
- Not parallel: T008/T010 (same spec file), T009/T011 (same component), T004 vs T002 (test-first ordering).

## Parallel Example: after T001 lands

```bash
# Track A (US1) and Track B (US2) and Track C (US3) simultaneously:
Task: "T002+T003 write failing queue-ordering tests, then T004 flip orderBy in human-tasks.controller.ts"
Task: "T006 extend runs-table.spec.ts, then T007 add Role column to Runs.vue"
Task: "T008 create agents-columns.spec.ts, then T009 split Name/Role in AgentsList.vue"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Skip T001 (US1 doesn't need it) → T002/T003 (failing tests) → T004 → T005.
2. **STOP and VALIDATE**: `pnpm test:integration -- human-queue`; manual check of both queue locations.
3. This alone delivers the only behavioral change operators asked for; ship if desired.

### Incremental Delivery

1. US1 → validate → deliverable (queue ordering fixed).
2. T001 + US2 → validate → deliverable (runs Role column).
3. US3 → US4 → validate → deliverable (agents page columns).
4. Polish phase (T012-T014) → final green + progress journal.

Realistically this whole feature is one PR (per the project's iteration-as-one-PR workflow); the story boundaries above are safe intermediate commit/validation points inside it.

---

## Notes

- No contract (`packages/contracts`) or DB (`drizzle/`) changes anywhere — if a task seems to need one, stop and re-check the plan.
- The existing integration test pins the OLD ordering; T002 must land with T004 in the same commit range or CI is red — that is expected test-first behavior, not a conflict.
- Commit after each task or logical group; stop at any checkpoint to validate the story independently.

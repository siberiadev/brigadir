# Tasks: Sprint Sequencing — Guaranteed Execution Order for Blocked-By Chains

**Input**: Design documents from `specs/022-sprint-sequencing/` (plan.md, spec.md, research.md R1–R8, data-model.md, contracts/dashboard-waiting.md, quickstart.md)

**Tests**: MANDATORY — everything except the web tab is pipeline logic (Principle VI). Test tasks are included per story; UI tasks ship with light coverage per constitution.

**Organization**: grouped by user story; stories are independently testable increments. Reminder from research R1: the pull-based release loop already exists (`ReconcileService.reEvaluateDependencies`, tested in `test/integration/dependency-gate.spec.ts`) — tasks extend it, never rewrite it, and existing T057/T066 assertions must stay green throughout.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md (only in story phases)

## Phase 1: Setup (dependency-graph refactor, zero behavior change)

**Purpose**: make `scope-jql` importable from `libs/pipeline` without an import cycle (research R6) so the shared release service can live there.

- [X] T001 Move `libs/ingest/src/scope-jql.ts` file-wholesale (zero logic/comment edits — the HWM `since` comment is load-bearing) to `libs/jira/src/scope-jql.ts` and export `POLL_FIELDS`, `buildScopeJql`, `sinceClause`, `HWM_OVERLAP_MS` from `libs/jira/src/index.ts`; move its colocated unit spec alongside if one exists
- [X] T002 Update all imports of the moved module (`libs/ingest/src/poller.service.ts`, `libs/ingest/src/reconcile.service.ts`, any test importing from `@brigadir/ingest`/relative path) to `@brigadir/jira`; drop the old file and any stale re-export from `libs/ingest/src/index.ts`
- [X] T003 Baseline gate: `pnpm typecheck && pnpm lint && pnpm test` green; `test/integration/dependency-gate.spec.ts` and `test/integration/reconcile-catchup.spec.ts` pass unchanged

---

## Phase 2: Foundational (schema, contracts, shared release service)

**Purpose**: blocking prerequisites for every story — the four `tickets` columns, priority ingestion, waiting-state persistence, and the extracted `DependencyReleaseService`.

- [X] T004 [P] Add `priority?: { id: string; name: string }` to `JiraIssue['fields']` in `packages/contracts/src/jira.types.ts` (+ touch `jira.types.spec.ts` if it asserts field shape)
- [X] T005 [P] Add `priorityId` (int), `priorityName` (text), `blockedBy` (jsonb), `blockedState` (text) — all nullable — to `libs/database/src/schema/tickets.ts` and generate the checked-in migration in `drizzle/` (data-model.md §1)
- [X] T006 [P] Update `docs/architecture.md` §3 `tickets` DDL with the same four columns + comments (hard-won rule 5; DDL text prepared in data-model.md §1)
- [X] T007 Add `'priority'` to `POLL_FIELDS` in `libs/jira/src/scope-jql.ts`; in `libs/ingest/src/poller.service.ts` persist `priority_id` (parsed int of `fields.priority.id`, NULL on absence/unparseable) + `priority_name` on ticket insert and on the per-issue update; clear `blocked_by`/`blocked_state` whenever the observed status changes (the release pass re-establishes them if still applicable)
- [X] T008 Extract `DependencyReleaseService` into `libs/pipeline/src/dependency-release.service.ts`: move the body of `ReconcileService.reEvaluateDependencies` (candidate query, batched `key in` fetch with `POLL_FIELDS`, gate check, `RunTriggerService.trigger` loop) unchanged in behavior; register in `libs/pipeline/src/pipeline.module.ts`; `libs/ingest/src/reconcile.service.ts` step 2 delegates to it (same step name/logging posture)
- [X] T009 Waiting-state persistence (data-model.md §2): in `libs/pipeline/src/pipeline.service.ts` blocked-skip branch (`onStatusChanged`) write `blocked_by` = open blocker keys + `blocked_state='waiting'`; in `DependencyReleaseService` each pass update `blocked_by` from the fresh fetch, set `waiting` for still-blocked candidates, and clear both columns for tickets it releases
- [X] T010 Foundational tests: extend `test/integration/dependency-gate.spec.ts` — blocked trigger-status ticket gets `blocked_by`+`blocked_state='waiting'` persisted; state clears when the blocker completes and the run triggers; T057/T066 assertions unchanged

**Checkpoint**: schema live, priority flowing, waiting set persisted, release service extracted — all stories unblocked.

---

## Phase 3: User Story 1 — chain executes itself in order (P1) 🎯 MVP

**Goal**: A→B→C laid out at once walks to the end with zero human action; both blocker-completion paths release; the system's own completion releases immediately (fast path).

**Independent Test**: quickstart Scenario 1 + 5 — chain E2E with run-success path and human-completion path; fast path releases without a reconcile pass; failure of the fast path never fails finalization.

- [X] T011 [US1] Add `releaseDependentsOf(workspaceId, blockerJiraKey)` to `libs/pipeline/src/dependency-release.service.ts`: narrow the candidate set to tickets whose `blocked_by` jsonb array contains the key (`@>` containment), then run the same fetch→gate→trigger pass (research R7)
- [X] T012 [US1] Fast-path call in `libs/pipeline/src/pipeline.service.ts` `onWorkerFinished` success branch: after `transitionTo(statusSuccess)` succeeds, call `releaseDependentsOf` in try/catch, log-and-continue on failure (guarantee remains the reconcile pass; FR-003)
- [X] T013 [US1] Integration test (extend `test/integration/dependency-gate.spec.ts` or new `test/integration/sprint-sequencing.spec.ts`): full chain A→B→C all in trigger status → exactly one run at a time in chain order, 3 runs total, zero duplicate runs (SC-001/SC-003; quickstart Scenario 1)
- [X] T014 [P] [US1] Integration test: human-completion path — covered by the extended T066 assertions in test/integration/dependency-gate.spec.ts (moveBlocker → next pass fires exactly once, waiting cache cleared)
- [X] T015 [US1] Integration test: fast path — after `onRunFinished` of the blocker's successful run, the dependent's run exists WITHOUT any explicit re-eval call; and with mock-jira failing the dependent fetch, finalization still completes and the dependent releases on the next pass (quickstart Scenario 5)

**Checkpoint**: MVP — chained sprints self-execute end-to-end.

---

## Phase 4: User Story 2 — deterministic release order (P2)

**Goal**: simultaneously released tickets start in priority order (ASC id, NULLS LAST), tiebreak `jira_key`; identical order on every repetition.

**Independent Test**: quickstart Scenario 2 — B(High)/C(Low)/D(no priority) blocked by A; on A's completion order is B→C→D, 10/10 repetitions identical.

- [X] T016 [US2] Canonical comparator (priority_id ASC NULLS LAST, then `jira_key` lexicographic ASC — data-model.md §4) applied to the candidate list in `libs/pipeline/src/dependency-release.service.ts` before the trigger loop (both entry points: full pass and `releaseDependentsOf`); colocated unit spec `libs/pipeline/src/dependency-release.spec.ts` covering priority order, NULLS LAST, tiebreak, and stability
- [X] T017 [US2] Integration test (in `test/integration/sprint-sequencing.spec.ts`): priority wave — three tickets with mixed/missing priorities released by one completion trigger in comparator order; loop the scenario 10× asserting identical enqueue order (SC-004; mock-jira issues seeded with `priority` field)

**Checkpoint**: release order deterministic and priority-respecting.

---

## Phase 5: User Story 3 — waiting visibility in the dashboard (P2)

**Goal**: blocked trigger-status tickets visible as "waiting on [keys]" with priority, state tag, no log access needed; list drains as chains progress.

**Independent Test**: quickstart Scenario 3 — endpoint returns the waiting row with blocker keys; row disappears after release; Waiting tab renders with pagination rules.

- [X] T018 [P] [US3] `BlockedStateSchema` + `WaitingTicketSchema` + `WaitingListResponseSchema = makePaginatedResponseSchema(WaitingTicketSchema)` in `packages/contracts/src/dashboard.schema.ts` exactly per `contracts/dashboard-waiting.md`; export via `packages/contracts/src/index.ts`
- [X] T019 [US3] `GET /api/workspaces/:id/waiting` in `apps/backend/src/dashboard/workspaces.controller.ts`: `parsePagination` from `dashboard.helpers.ts`, rows `WHERE workspace_id=:id AND blocked_state IS NOT NULL`, `ORDER BY priority_id ASC NULLS LAST, jira_key ASC`, 404 on unknown workspace
- [X] T020 [US3] Endpoint integration test (in `test/integration/sprint-sequencing.spec.ts` alongside the seeded waiting states): envelope shape validates against `WaitingListResponseSchema`, deterministic order, released ticket disappears, 404 case
- [X] T021 [P] [US3] Web data layer: `apps/web/src/api/tickets.ts` (fetch wrapper) + `apps/web/src/composables/useWaitingTickets.ts` — TanStack query keyed by (workspaceId, page, pageSize) with `placeholderData: (prev) => prev`, paired with `usePagination`/`bindTotal`
- [X] T022 [US3] `apps/web/src/views/WorkspaceWaiting.vue` + `waiting` child route in `apps/web/src/router/index.ts` + tab entry in `apps/web/src/views/WorkspacePage.vue`: table (jira_key, summary, priority_name, blocked_by keys, state tag), shared `<ListPagination>`, state tags colored only via `--el-color-*` variables, static lucide icons (no hover animation — sidebar-only rule)

**Checkpoint**: operators see and can audit the waiting set.

---

## Phase 6: User Story 4 — diagnosable dead ends and cycles (P3)

**Goal**: cycles and dead-end waits are classified and visible; out-of-scope blockers additionally raise exactly one run-less human task per ticket.

**Independent Test**: quickstart Scenario 4 — cycle/dead-end/out-of-scope each produce their state (and the human task for out-of-scope, deduped across passes); done-category resolution control case releases normally.

- [ ] T023 [US4] Classification probes in `libs/pipeline/src/dependency-release.service.ts` (research R4): batched blocker fetch `key in (<blockers>)` with fields `status,resolution` (no project clause) → `dead_end` when resolution set ∧ category ≠ done; scope probe `buildScopeJql(scope) AND key in (<blockers>)` (NO `since` clause) → `out_of_scope` for absentees; precedence `cycle > out_of_scope > dead_end > waiting` (data-model.md §2); probes run only when the waiting set is non-empty
- [ ] T024 [US4] Cycle detection over the persisted waiting set (DFS on `blocked_by` keys restricted to waiting trigger-status tickets of the workspace) → `blocked_state='cycle'` for members; pure function + colocated unit tests in `libs/pipeline/src/dependency-release.spec.ts` (2-cycle, 3-cycle, no-cycle chain, self-link)
- [ ] T025 [US4] `HumanTaskService.createTicketBlocked(workspaceId, ticketId, {title, details})` in `libs/human-tasks/src/human-task.service.ts`: run-less insert (`run_id NULL`, `kind='blocker'`, `blocking=false`), dedup = existing open task with same `ticket_id` and `run_id IS NULL` (research R5); called from the release pass for `out_of_scope` tickets with title/details naming the blocker keys
- [ ] T026 [P] [US4] mock-jira harness support in `test/integration/mock-jira.ts`: blocker issues with `resolution` field, cross-project keys resolvable via `key in` search without project clause, scope-probe JQL answering (sprint/project membership)
- [ ] T027 [US4] Integration tests (in `test/integration/sprint-sequencing.spec.ts`): cycle X⇄Y → no runs + both `cycle`; dead-end (resolution set, non-done category) → `dead_end`, no run, no task; out-of-scope blocker → `out_of_scope` + exactly one open human task, second pass no duplicate, resolving task without board change → re-created later, breaking the link → state clears; control: Won't-Do INTO done category → releases normally (quickstart Scenario 4)

**Checkpoint**: nothing waits silently; every never-self-resolving condition is visible or task-raised.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T028 [P] Guard-rail sweep: full `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` — existing idempotency tests, `sinceClause` format tests, T057/T066 all unchanged; review migration SQL against `docs/architecture.md` §3 diff (rule 5)
- [ ] T029 [P] Iteration entry in `docs/progress.md` (feature 022: what shipped, R1 correction of the brief's premise, deferred cap decision pointer)
- [ ] T030 Manual smoke per quickstart "Full stack": `docker compose up --build`, lay a chain on a board, watch the Waiting tab drain

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → all stories**: Setup and Foundational are strictly blocking.
- **US1 (Phase 3)**: depends on Foundational only. **US2 (Phase 4)**: depends on Foundational (priority columns); independent of US1 (comparator applies to both entry points but T016 can land before/after T011 — if before, it covers only the full pass until T011 exists). **US3 (Phase 5)**: depends on Foundational (persisted state); independent of US1/US2 (endpoint shows `waiting` rows without ordering/fast-path). **US4 (Phase 6)**: depends on Foundational; T023 precedence interacts with T024 (cycle wins) — do T024 before or together with T023.
- Recommended order: Phases in sequence (1→7); within stories, [P]-marked tasks parallelize.

### Parallel opportunities

- Phase 2: T004 ∥ T005 ∥ T006 (different files), then T007–T010 sequential (same services).
- Phase 3: T014 ∥ T015 after T013's harness scaffolding.
- Phase 5: T018 ∥ T021 (contracts vs web data layer), then T019→T020, T022 last.
- Phase 6: T026 ∥ T023/T024.
- Phase 7: T028 ∥ T029.

## Implementation Strategy

**MVP = Phases 1–3** (US1): chained sprints self-execute with the fast path — the P1 promise, provable by quickstart Scenarios 1+5. Then US2 (ordering) and US3 (visibility) as independent increments, US4 (diagnostics) last. Each checkpoint leaves the suite green and the branch shippable; commit per phase.

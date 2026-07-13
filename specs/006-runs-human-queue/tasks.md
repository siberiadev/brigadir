---
description: "Task list — Runs Visibility & Human Queue (feature 006)"
---

# Tasks: Runs Visibility & Human Queue

**Input**: Design documents from `/specs/006-runs-human-queue/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: MANDATORY for all pipeline logic (constitution Principle VI + CLAUDE.md rule 4) —
executor CRUD/seeding/backfill, concurrency re-apply, multi-workspace reconcile, cancel guard,
retry dedup, human-queue resolve. Backend/worker tests are testcontainers + mock-jira, no broker
mocks, per-suite `BULLMQ_PREFIX`, in `test/integration/`. Frontend gets msw component tests in
`apps/web/test/` (extending `mount.ts` + `handlers.ts`).

## Session split (per user request)

This feature's implement phase runs as **two sessions**. Phases are grouped so the two bodies of
work are cleanly separable:

- **SESSION 1 — Backend & Worker** (Phases 1–5): contracts, executors CRUD + seeding + backfill,
  concurrency re-apply, multi-workspace reconcile, runs/human-queue endpoints, index migration.
  All backend/worker integration tests green at the end of Session 1.
- **SESSION 2 — Frontend** (Phases 7–12): api modules, Query composables, views, components,
  msw component tests, navbar/landing/route wire-up, docs.

Contracts (Phase 1) are the only shared prerequisite; the frontend consumes them as typed source
but its tests fake the API with msw, so Session 2 does not depend on a running backend.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 (Setup/Foundational/Polish carry no story label)

---

# ═══════════════════════════ SESSION 1 — BACKEND & WORKER ═══════════════════════════

## Phase 1: Contracts (Foundational — blocks Sessions 1 AND 2)

**Purpose**: The single typed source (`packages/contracts`) consumed by backend controllers, the
worker, and the Vue composables. **⚠️ CRITICAL**: no other phase may begin until this is complete.

- [X] T001 [P] Add `packages/contracts/src/runs.schema.ts` — zod + types for runs-table row/list
  response, cost response, run-card response (run/ticket/checks/events/history), cancel & retry
  responses, per `contracts/runs-api.md` (snake_case, shared error envelope).
- [X] T002 [P] Add `packages/contracts/src/human-queue.schema.ts` — zod + types for the human-task
  list item (open + closed-only fields) and the `{ open: number }` count response, per
  `contracts/human-queue-api.md`. Reuse the existing `resolve-human-task.schema.ts` unchanged.
- [X] T003 [P] Add `packages/contracts/src/executor.schema.ts` — the discriminated-union config
  schema (`mock` = concurrency only; `claude_cli` = model, cli_path, repository, use_callback_channel,
  keep_failed_worktrees, max_turns, concurrency_limit) + list-item/create/update request+response
  types, per `contracts/executors-api.md`. This is the shared authority for backend validation and
  the Vue form.
- [X] T004 [P] Add `packages/contracts/src/executor.schema.spec.ts` — unit tests for the union:
  accepts valid mock & claude_cli, rejects a foreign field (mock carrying `max_turns`), rejects
  missing required claude_cli fields. (Constitution VI: typed-config validation is pipeline logic.)
- [X] T005 [P] Extend `packages/contracts/src/jira.types.ts` — add optional `enabled?: boolean` to
  `WorkspaceSettings` (absent ⇒ treated as enabled; data-model additive item 2).
- [X] T006 Export the new schemas from `packages/contracts/src/index.ts` (runs, human-queue,
  executor) so backend and web resolve them by package path. (depends on T001–T003, T005)

**Checkpoint**: `pnpm --filter @brigadir/contracts test` green; types importable everywhere.

---

## Phase 2: Executors administration — backend (US4) 🎯 iteration-5 debt

**Goal**: REST CRUD for workspace-scoped executors with typed validation + delete-guard; default
seeding on workspace create; bootstrap backfill so no workspace ever has an empty picker.

**Independent Test**: Create a workspace → exactly one `claude_cli` "claude" + one `mock` "mock"
exist; CRUD via endpoints; delete a referenced executor → 409; invalid typed config → 422.

### Tests for US4 (write first, ensure they FAIL) ⚠️

- [X] T007 [P] [US4] `test/integration/executor-seeding.spec.ts` — creating a workspace seeds exactly
  one `claude_cli` "claude" (repository = workspace default repo when present) + one `mock` "mock"
  (FR-022, SC-006).
- [X] T008 [P] [US4] `test/integration/executor-crud.spec.ts` — GET list (shape, secrets never
  serialized), POST create (201), PUT update, name-conflict 409 (`executor_name_taken`), invalid
  typed config 422 (foreign field, unknown repository) (FR-020, FR-021).
- [X] T009 [P] [US4] `test/integration/executor-delete-guard.spec.ts` — DELETE unreferenced → 204;
  DELETE referenced-by-agents → 409 `executor_in_use` naming the agents, no orphaned refs (FR-024,
  SC-009).
- [X] T010 [P] [US4] `test/integration/executor-backfill.spec.ts` — `OnApplicationBootstrap` backfill
  is **type-scoped**: a pre-006 workspace with zero executors gets both defaults; a workspace with a
  custom-named executor of a type gains no duplicate for that type; existing rows unmodified.

### Implementation for US4

- [X] T011 [US4] Add `apps/backend/src/dashboard/executors.controller.ts` — GET/POST/PUT/DELETE under
  `/api/workspaces/:id/executors`, `DashboardTokenGuard`, typed-config validation via
  `executor.schema` (T003), persistence mapping (`concurrency_limit` → column; rest → `config` jsonb;
  `name`/`type` columns), secrets never returned, delete pre-count of referencing agents → 409.
- [X] T012 [US4] Add a seeding helper (e.g. `apps/backend/src/dashboard/executor-seed.ts`) and wire it
  into `apps/backend/src/dashboard/workspaces.controller.ts` `create` — insert-if-absent both defaults
  after the workspace row (idempotent via `executors_workspace_name` unique index) (FR-022).
- [X] T013 [US4] Add the `OnApplicationBootstrap` type-scoped backfill (reusing the T012 helper) that
  seeds defaults for every existing workspace lacking an executor of a given type (executors-api.md
  "Backfill").
- [X] T014 [US4] Register `ExecutorsController` (+ any provider) in
  `apps/backend/src/dashboard/dashboard.module.ts`.

**Checkpoint**: Executor CRUD + seeding + backfill integration tests green.

---

## Phase 3: Live concurrency re-apply — worker (US4 / FR-025)

**Goal**: Changing an executor's `concurrency_limit` re-applies to the live worker within ~15 s with
no restart; multiple executors of a type ⇒ applied concurrency is their sum.

**Independent Test**: Change a limit via DB/endpoint → the running `Worker.concurrency` for that type
reflects the new sum without a process restart.

### Tests for US4 (write first) ⚠️

- [X] T015 [P] [US4] `test/integration/concurrency-reapply.spec.ts` — with live workers, update
  `executors.concurrency_limit`, advance the interval, assert `worker.concurrency` equals the summed
  per-type limit; no restart (FR-025, SC-008, Edge Case "Concurrency re-apply").

### Implementation for US4

- [X] T016 [US4] Add a periodic re-apply (reusing `apps/worker/src/executor-concurrency.ts`
  `applyExecutorConcurrency`) in `apps/worker/src/run.processor.ts` (mock worker) on a ~15 s timer.
- [X] T017 [US4] Add the same periodic re-apply in `apps/worker/src/claude-cli-run.processor.ts`
  (claude_cli worker). Timer resolves the DB live, never at module composition (constitution
  lazy-resolution rule).

**Checkpoint**: Concurrency-reapply test green; boot-time wiring behavior unchanged.

---

## Phase 4: Multi-workspace reconcile — worker (US5) 🎯 iteration-5 debt

**Goal**: One reconcile pass processes **every enabled** workspace with its own board scope / HWM /
dependency re-eval / watchdog / drift and a per-workspace Jira client; disabled workspaces skipped;
one workspace's outage never aborts the loop.

**Independent Test**: Two enabled + one disabled → one pass polls both enabled, skips the disabled;
make one enabled workspace's Jira fail → the other still completes.

### Tests for US5 (write first) ⚠️

- [X] T018 [P] [US5] `test/integration/reconcile-multiworkspace.spec.ts` — two enabled + one disabled:
  one pass polls both enabled, skips the disabled entirely (FR-026, FR-028).
- [X] T019 [P] [US5] `test/integration/reconcile-outage-isolation.spec.ts` — two enabled where A's
  Jira throws: B's pass still completes; A logged and skipped for that pass only (FR-029).
- [X] T020 [P] [US5] `test/integration/reconcile-per-ws-client.spec.ts` — a Jira call for workspace B
  uses B's site/credentials, not A's; per-workspace HWM/board scope preserved (FR-027, FR-026).

### Implementation for US5

- [X] T021 [US5] Export `JiraClientFactory` from the worker-side provider set in
  `libs/jira/src/jira.module.ts` so it can be injected into `ReconcileService` (resolves lazily inside
  `forWorkspace`, never at composition).
- [X] T022 [US5] Refactor `libs/ingest/src/reconcile.service.ts` `run()` — select workspaces
  `WHERE settings->>'enabled' IS DISTINCT FROM 'false'` (drop `.limit(1)`), loop with a per-workspace
  try/catch (FR-029), `jira = factory.forWorkspace(ws.id)`, `ensureBoardType(ws, jira)` (skip ws on
  null), then the four steps; `reEvaluateDependencies(ws, jira)`.
- [X] T023 [US5] Update `libs/ingest/src/poller.service.ts` — `pollAndDiff(ws, jira)`; drop
  `@Inject(JIRA_CLIENT)`.
- [X] T024 [US5] Update `libs/ingest/src/drift-repair.service.ts` — `repair(ws, jira)` (thread the
  client only if it makes Jira calls; otherwise keep as-is). Confirm `watchdog.service.ts` is DB-only
  (`sweep(ws)` unchanged).

**Checkpoint**: Multi-workspace reconcile tests green; single-workspace happy path unchanged.

---

## Phase 5: Runs + Human-queue endpoints + index migration (US1/US2/US3)

**Goal**: Read/projection endpoints for the runs table, run card, cost, and human queue; guarded
cancel; retry via manual-trigger; the resolve endpoint gains the dashboard guard; the supporting
index lands.

**Independent Test**: Seed runs/checks/events/human-tasks; list with filters+pagination; open a card
(4 check states, timeline, history, failure diagnostics); cancel a running run (no `awaiting_human`
overwrite); retry → 409 when active exists; queue list/count; resolve resumes a blocking task.

### Tests (write first) ⚠️

- [X] T025 [P] [US3] `test/integration/runs-list.spec.ts` — GET runs: agent/status/ticket-key filters,
  pagination reflects the filtered `total`, `created_at desc`, empty workspace → `items: []`
  (FR-015, FR-016).
- [X] T026 [P] [US3] `test/integration/runs-cost.spec.ts` — GET runs/cost per period (24h/7d/30d):
  `total_cost_usd` + `run_count` (FR-019, SC-010).
- [X] T027 [P] [US2] `test/integration/run-card.spec.ts` — GET run: run/ticket/checks (4 states ordered
  by position)/events (chronological)/history; failure `error` present; partial report → `checks: []`;
  unknown id → 404 (FR-007–FR-011).
- [X] T028 [P] [US2] `test/integration/run-cancel-guard.spec.ts` — cancel a `running` run flips to
  `cancelled`; cancel an `awaiting_human` run → `cancelled:false, reason:not_running`, state NOT
  overwritten (FR-012, constitution rule #7).
- [X] T029 [P] [US2] `test/integration/run-retry.spec.ts` — retry a finished run → new `run_id` via
  manual-trigger; retry where an active run exists → 409 `active_run_exists`; unknown id → 404
  (FR-013, Edge Case "Retry semantics").
- [X] T030 [P] [US1] `test/integration/human-queue.spec.ts` — GET list open (oldest-first) & closed
  (resolved_at desc); GET count; resolve (guarded) with `resume` on a blocking task creates a new
  attempt and closes the task (FR-001, FR-005, FR-006, FR-003, FR-004, SC-004).

### Implementation

- [X] T031 [P] Add the additive index migration in `drizzle/` —
  `index('runs_workspace_created').on(runs.workspaceId, runs.createdAt.desc())` (+ committed
  `REVIEW-*.md` per constitution rule #5); update the Drizzle schema `libs/database/src/schema/runs.ts`.
- [X] T032 [US3] Add `apps/backend/src/dashboard/runs.controller.ts` GET `/api/workspaces/:id/runs`
  (list, filters, pagination, join tickets+agents, duration/cost derivation) and GET
  `/api/workspaces/:id/runs/cost` (period sum) (FR-015, FR-016, FR-019).
- [X] T033 [US2] Add to `runs.controller.ts`: GET `/api/runs/:id` (card read model — run/ticket/checks/
  events/history), POST `/api/runs/:id/cancel` (guarded `WHERE status='running'`), POST
  `/api/runs/:id/retry` (reuse `RunTriggerService.trigger({ ticketId, agentId })`) (FR-007–FR-013).
- [X] T034 [US1] Add `apps/backend/src/dashboard/human-tasks.controller.ts` GET `/api/human-tasks`
  (open/closed, global across workspaces) + GET `/api/human-tasks/count` (FR-001, FR-005, FR-006).
- [X] T035 [US1] Apply `DashboardTokenGuard` to `libs/human-tasks/src/resolve.controller.ts` (was
  unguarded) — behavior unchanged, guard only (FR-032, FR-033).
- [X] T036 Register `RunsController` + `HumanTasksController` in
  `apps/backend/src/dashboard/dashboard.module.ts`.

**Checkpoint — SESSION 1 EXIT**: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`
all green. Backend/worker feature-complete; frontend can begin.

---

# ═══════════════════════════ SESSION 2 — FRONTEND ═══════════════════════════

> Prerequisite: Phase 1 (contracts). Frontend tests fake the API with msw, so a running backend is
> not required. Foundation task T037 precedes all frontend feature phases.

## Phase 7: Frontend foundation (api client + shared handlers)

- [X] T037 [P] Add typed api modules `apps/web/src/api/{runs,humanTasks,executors}.ts` (using the
  existing `apiClient` in `apps/web/src/api/client.ts` and the Phase-1 contract types) and extend
  `apps/web/test/handlers.ts` with msw handlers for the new endpoints (list/card/cost/cancel/retry,
  queue list/count/resolve, executors CRUD).

**Checkpoint**: api modules typecheck; msw handlers available to component tests.

---

## Phase 8: Clear the needs-human queue — UI (US1) 🎯 MVP

**Goal**: Global queue list with resolution actions (resume/done_manually/dismiss), history filter,
and a live navbar open-task badge.

**Independent Test**: Load the queue, resolve a blocking task with "resume" + answer → task leaves the
open list; switch to history → closed tasks show resolution + resolver; badge count updates.

- [X] T038 [P] [US1] Add `apps/web/src/composables/useHumanTasks.ts` — Query hooks for list
  (open|closed) and count, with `refetchInterval` (~3 s for the count/badge), plus a resolve mutation.
- [X] T039 [US1] Fill `apps/web/src/views/HumanQueue.vue` — open list (title, ticket, agent, kind, age,
  blocking flag; oldest-first), per-task resolution form (answer + resume/done_manually/dismiss),
  history filter, empty state (FR-001–FR-006).
- [X] T040 [P] [US1] `apps/web/test/human-queue.spec.ts` — msw component test: renders open tasks;
  resume submits to resolve and removes the task; history filter shows closed with resolution/resolver.

**Checkpoint**: Human queue works against faked APIs; component test green.

---

## Phase 9: Read an agent's report & diagnose a run — UI (US2)

**Goal**: Run/ticket card — report checklist (✅/❌/⚠/⏭ + expandable reason), ticket header + Jira deep
link + status, run history, event timeline, failure diagnostics, cancel/retry.

**Independent Test**: Open a seeded card → 4 glyphs render, reasons expand, timeline + history show,
failed run shows stderr, cancel/retry hit the faked endpoints.

- [X] T041 [P] [US2] Add `apps/web/src/composables/useRunCard.ts` — Query hook for GET `/api/runs/:id`
  with `refetchInterval` (~3 s while the run is non-terminal; terminal cards do not poll), plus cancel
  and retry mutations.
- [X] T042 [US2] Add `apps/web/src/views/RunCard.vue` — header (key/summary/Jira link/status), report
  checklist with expandable reasons, run history table (agent/executor/attempt/duration/cost/outcome),
  chronological timeline, failure diagnostics block, cancel + retry buttons (FR-007–FR-014). Handle
  partial reports / missing summary / null cost gracefully.
- [X] T043 [P] [US2] `apps/web/test/run-card.spec.ts` — msw component test: 4 check glyphs + reason
  expand; timeline + history render; failed run shows diagnostics; cancel/retry call the endpoints.

**Checkpoint**: Run card works against faked APIs; component test green.

---

## Phase 10: Browse & filter runs in a workspace — UI (US3)

**Goal**: Runs tab — paginated table (agent, ticket+Jira link, status, attempt, duration, cost),
agent/status filters + ticket-key search, live refresh, row → card, header cost figure with period.

**Independent Test**: Load the Runs tab, apply agent/status/ticket filters → rows narrow; change cost
period → total updates; click a row → card opens.

- [X] T044 [P] [US3] Add `apps/web/src/composables/useRuns.ts` — Query hooks for the runs list (filters +
  pagination) and the cost figure, with `refetchInterval` (~4–5 s for the focused table).
- [X] T045 [US3] Replace the placeholder `apps/web/src/views/Runs.vue` — table + agent/status filters +
  ticket-key search + pagination + cost header (period presets 24h/7d/30d) + row-click → run card;
  empty state, not an error (FR-015–FR-019).
- [X] T046 [P] [US3] `apps/web/test/runs-table.spec.ts` — msw component test: filters narrow rows &
  pagination reflects the filtered set; cost period switch updates the total; row click routes to the
  card.

**Checkpoint**: Runs tab works against faked APIs; component test green.

---

## Phase 11: Executors admin UI + agent picker + pause toggle (US4, US5)

**Goal**: Workspace-settings Executors section with a typed per-type config form; the agent form's
picker reads `/executors` (names + type badge, defaults to claude_cli); the workspace enabled/pause
toggle.

**Independent Test**: Open settings → list/create/update/delete executors with type-specific fields;
open the agent form → picker shows names + badges, defaults to claude_cli, never a UUID/empty; toggle
workspace pause → persisted via settings.

- [X] T047 [P] [US4] Add `apps/web/src/composables/useExecutors.ts` — Query hooks + create/update/delete
  mutations for `/api/workspaces/:id/executors`.
- [X] T048 [US4] Add `apps/web/src/components/ExecutorForm/…` — typed per-type config form driven by the
  Phase-1 `executor.schema` union (mock: concurrency; claude_cli: model, cli_path, repository select
  from workspace repos, callback toggle, keep-failed-worktrees toggle, max turns, concurrency) (FR-021).
- [X] T049 [US4] Add an Executors section to `apps/web/src/views/WorkspaceSettings.vue` (list + create/
  edit via ExecutorForm + delete with the in-use error surfaced) **and** the workspace enabled/pause
  toggle writing `settings.enabled` via the existing settings endpoint (FR-020, FR-024, FR-030, US5).
- [X] T050 [US4] Update `apps/web/src/components/AgentForm/AgentForm.vue` — executor picker reads
  `useExecutors` (names + type badge, never a raw UUID, never empty, defaults to the workspace's
  claude_cli executor), replacing the discovery workaround (FR-023).
- [X] T051 [P] [US4] `apps/web/test/executor-form.spec.ts` — msw component test: type switch shows only
  that type's fields; create/update/delete; delete-in-use surfaces the 409 message. Update
  `apps/web/test/agent-form.spec.ts` for the new picker (names + badge + claude_cli default).

**Checkpoint**: Executors admin + agent picker + pause toggle work against faked APIs; tests green.

---

## Phase 12: Wire-up, navigation & docs (cross-cutting)

- [X] T052 [US1] Add the navbar open-task badge in `apps/web/src/App.vue` bound to `useHumanTasks`
  count (live ~3 s) and the landing rule: `open > 0` → human queue is the default landing view; else
  workspaces (FR-002, FR-005).
- [X] T053 Add routes in `apps/web/src/router/index.ts` — run card (`/runs/:id`) and the workspace
  Runs tab + settings routes; ensure all new routes are behind the existing auth flow (FR-032).
- [X] T054 [P] Update `docs/progress.md` with the iteration-6 entry (surfaces shipped, the two-item
  additive schema note) and `docs/local-setup.md` if any env/setup note changed.
- [ ] T055 Run `specs/006-runs-human-queue/quickstart.md` Scenarios A–E end-to-end against a live
  stack; fix any gaps. Final `pnpm typecheck && pnpm lint && pnpm test` (+ `pnpm test:integration`).

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Contracts)** — blocks everything (both sessions). No dependency.
- **Session 1**: Phase 2 (executors backend), Phase 3 (concurrency), Phase 4 (reconcile) are mutually
  independent after Phase 1 and may run in any order / parallel. Phase 5 (runs + queue endpoints) is
  independent of 2–4 but conventionally last in Session 1. T035 (guard resolve) has no dependency on
  the human-tasks controller.
- **Session 2**: Phase 7 (foundation) after Phase 1. Phases 8–11 each depend on Phase 7 and are
  mutually independent (different views/composables/tests) — parallelizable. Phase 12 depends on
  Phases 8–11 (badge/landing need the queue composable; routes need the card/runs views).

### Within a phase

- Tests (marked ⚠️) written first and FAIL before implementation.
- Contracts → controllers/composables → views → wire-up.
- `[P]` = different files, no incomplete dependency.

### Parallel opportunities

- **Phase 1**: T001–T005 all `[P]`; T006 after.
- **Phase 2**: tests T007–T010 `[P]`; then T011 → T012 → T013 (share the seed helper) → T014.
- **Phase 4**: tests T018–T020 `[P]`; T021 before T022; T022 before T023/T024.
- **Phase 5**: tests T025–T030 `[P]`; T031 `[P]`; T032/T033 same file (sequential), T034 `[P]`.
- **Session 2**: after T037, the four feature phases (8/9/10/11) can be built in parallel by
  different developers; each phase's `[P]` test task runs alongside its view.

---

## Parallel Example: Phase 5 tests (Session 1)

```bash
# Launch the runs/queue backend integration tests together (all fail first):
Task: "runs-list.spec.ts — filters + pagination"        # T025
Task: "runs-cost.spec.ts — period sums"                 # T026
Task: "run-card.spec.ts — card read model"              # T027
Task: "run-cancel-guard.spec.ts — awaiting_human guard" # T028
Task: "run-retry.spec.ts — manual-trigger + 409"        # T029
Task: "human-queue.spec.ts — list/count/resolve"        # T030
```

---

## Implementation Strategy

### MVP (US1 slice)

Contracts (Phase 1) → executors backend just enough to unblock (Phase 2) → human-queue endpoints
(T030, T034, T035) in Session 1 → Phase 7 + Phase 8 in Session 2. That closes product pain #3 (the
needs-human queue) and is independently demoable.

### Session 1 → Session 2 handoff

Session 1 exits at the Phase 5 checkpoint with all backend/worker integration tests green. Session 2
starts from contracts + faked APIs (msw), so it never blocks on backend availability; the two sessions
share only `packages/contracts`.

### Incremental delivery

1. Session 1 lands executors debt (US4 backend), multi-workspace (US5), and the read/action endpoints
   (US1/US2/US3) — all test-backed.
2. Session 2 lands the queue (US1) → card (US2) → runs table (US3) → executors admin/pause (US4/US5) →
   wire-up, each independently testable against msw before the quickstart end-to-end pass.

---

## Notes

- Constitution guards to preserve: cancel is `WHERE status='running'` (rule #7); retry rides the three
  idempotency layers (no bypass); Jira writes untouched (this feature writes none); per-workspace Jira
  client resolved lazily inside `forWorkspace`; suite isolation by `BULLMQ_PREFIX`.
- No structural schema change: one additive index (T031) + `settings.enabled` jsonb flag (T005) only.
- Commit after each task or logical group; stop at any checkpoint to validate independently.

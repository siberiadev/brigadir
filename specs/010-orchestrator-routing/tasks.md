---
description: "Task list for Orchestrator-Based Blocked-Ticket Routing ('brigadir' agent)"
---

# Tasks: Orchestrator-Based Blocked-Ticket Routing ("brigadir" agent)

**Input**: Design documents from `/specs/010-orchestrator-routing/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D12), data-model.md, contracts/

**Tests**: MANDATORY per Constitution VI — every new pipeline path (triage trigger, decision
processing, budget guard, override, resume picker, handoff assembly) ships with unit + integration
tests in the same change, against real Postgres/Redis under the mock executor. UI-only tasks carry
no separate test task.

**Organization**: Grouped by user story (US1 P1 → US2 P2 → US3 P2 → US4 P3) for independent
implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: Which user story the task belongs to (US1–US4)
- Exact file paths are included in every task

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline for an existing NestJS + Vue monorepo — no new top-level tree.

- [X] T001 Confirm baseline green on branch `010-orchestrator-routing`: run `pnpm typecheck && pnpm lint && pnpm test` from repo root and note current state before edits.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB schema, contracts vocabulary, and settings accessors that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Create migration `drizzle/0004_orchestrator_routing.sql` (`ALTER TABLE agents ADD COLUMN description text`; `ADD COLUMN is_orchestrator boolean NOT NULL DEFAULT false`; `CREATE TABLE global_settings(key text PK, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`) and companion `drizzle/REVIEW-0004_orchestrator_routing.md` reviewing the SQL against `docs/architecture.md` §3 (rule 5).
- [X] T003 [P] Extend agents schema in `libs/database/src/schema/agents.ts` with `description` (text, nullable) and `is_orchestrator` (boolean, not null, default false); re-export via `libs/database/src/schema/index.ts`.
- [X] T004 [P] Add `global_settings` table schema in `libs/database/src/schema/global-settings.ts` (key PK, value jsonb, updated_at) and re-export via `libs/database/src/schema/index.ts`.
- [X] T005 [P] Add typed `rework_max` accessor (default 2) to `libs/database/src/workspace-settings.ts` reading `workspaces.settings.rework_max` (no DDL).
- [X] T006 Extend `packages/contracts/src/trigger-event.schema.ts`: fix `'human_resume'`→`'human-resume'`, add `'triage'` and `'rework'` sources (final six-value vocabulary), add optional typed handoff fields (`failing_run_id`, `deciding_run_id`, `task`, `human_task_id`, `target_agent`), add `'routed'` to `MOCK_SCENARIOS`; re-export via `packages/contracts/src/index.ts`.
- [X] T007 [P] Contract test `packages/contracts/src/trigger-event.schema.spec.ts`: asserts the six-value source vocabulary, that a resumed mock run (`source='human-resume'`) validates (regression for the pre-existing crash — FR-023), and that handoff fields round-trip.
- [X] T008 [P] Add `packages/contracts/src/global-settings.schema.ts` (General-settings GET/PUT contract: `default_orchestrator_instruction` string field) and re-export via `packages/contracts/src/index.ts`.

**Checkpoint**: Schema + contract vocabulary ready — user stories can begin.

---

## Phase 3: User Story 1 - Failed run is automatically triaged and routed for rework (Priority: P1) 🎯 MVP

**Goal**: After a worker run fails, the pipeline auto-starts exactly one triage run for the orchestrator; a valid routing decision creates a rework run for the target worker with the failure context injected — no worker instruction change.

**Independent Test**: With the mock executor, fail a worker run → assert exactly one `source='triage'` run for the orchestrator; complete triage with `routed`→worker → assert a `source='rework'` run, ticket at the target's running status, and the rework prompt contains the task text + failing report context.

### Tests for User Story 1 (MANDATORY — Constitution VI) ⚠️

> Write these FIRST and ensure they FAIL before implementation.

- [X] T009 [P] [US1] Contract test `packages/contracts/src/report.schema.spec.ts`: `routed` outcome requires the `routing` payload (`target_agent`≤200, `task`≤4000, `.strict()`), `routed` without payload is rejected, mirroring the `needs_human`⇒`human_task` rule (FR-001).
- [X] T010 [P] [US1] Integration test `test/integration/orchestrator-routing-loop.integration.spec.ts`: full fail → triage → route → rework → success loop under the mock executor, asserting exactly-one triage (SC-001), rework prompt context (SC-002), Jira status/comments per step (SC-007), and a completion-replay no-op (AC US1-5).
- [X] T011 [P] [US1] Unit test `libs/pipeline/src/handoff.spec.ts`: triage-kind section (failing summary, failed/warning checks, artifacts, roster name+description, cycle count vs max, decision protocol) and rework-kind section (task, failing summary+checks, branch/PR, fix-of-existing-work framing); best-effort degradation on missing source data (FR-013).

### Implementation for User Story 1

- [X] T012 [US1] Add `routed` outcome + `routing` payload object and the `outcome==='routed'⇒routing` `superRefine` to `packages/contracts/src/report.schema.ts`; re-export via `packages/contracts/src/index.ts` (FR-001).
- [X] T013 [P] [US1] Create `libs/pipeline/src/rework-budget.ts` deriving `cycle_count = |runs where trigger_event.source==='rework'|` and `budget_available` vs `workspaces.settings.rework_max` (FR-006, D3).
- [X] T014 [US1] Create `libs/pipeline/src/handoff.ts` — pure `buildHandoffSection(triggerEvent, db)` producing bounded markdown for the `triage` and `rework` handoff kinds by reading referenced runs from Postgres (FR-012/013, D7).
- [X] T015 [US1] Extend `libs/runs/src/run-trigger.service.ts` to carry `triage` and `rework` trigger events (references to failing/deciding runs, task text), inheriting the three dedup layers (FR-004/008).
- [X] T016 [US1] In `libs/pipeline/src/pipeline.service.ts` `onRunFinished`: after the existing failure transition + comment and before the `jira_action` marker, if the run is a terminally-failed (`failed`/`timed_out`) non-orchestrator run and budget is available and an enabled orchestrator exists, enqueue exactly one triage run via `RunTriggerService`; record the decision (`triaged`) in the marker so replay no-ops (FR-004, D4/D5).
- [X] T017 [US1] In `libs/pipeline/src/pipeline.service.ts`: add the orchestrator-completion branch (guarded by `is_orchestrator`, no generic success/failure transition — FR-007) that, on `routed` + valid target + budget available, enqueues a rework run for the target, transitions the ticket directly to the target's `status_running` (no trigger-status passthrough), and posts a routing comment (FR-008, D6).
- [X] T018 [P] [US1] Add a `routed` scenario to `libs/executors/src/mock.executor.ts` returning a `routed` report with target from `trigger_event` (FR-024, D12).
- [X] T019 [P] [US1] Add a `routed` entry to `PANEL_BY_OUTCOME` and a target-agent+task comment line in `libs/jira/src/adf-composer.ts` (FR-024).
- [X] T020 [US1] Wire handoff injection into `apps/worker/src/run.processor.ts`: when the trigger carries a handoff source, prepend `buildHandoffSection(...)` to the assembled `RunContext.instruction` without persisting any instruction change (FR-012, SC-002).
- [X] T021 [US1] Wire the same handoff injection into `apps/worker/src/claude-cli-run.processor.ts` for `triage`/`rework` sources (leave the existing resume-answer path intact for now; replaced in US3) (FR-012).
- [X] T051 [P] [US1] Extend `scrubReport` in `libs/callback/src/callback.service.ts` to scrub `report.routing.task` like every other free-text report field, with a unit test asserting a secret in the routing task never reaches persistence (FR-003, Constitution V).
- [X] T052 [US1] Extend the branch-continuation predicate in `apps/worker/src/claude-cli-run.processor.ts` (today: `trigger_event.source === 'human-resume'` only) to also treat `'rework'` as a resumed attempt so the rework run reuses the existing branch instead of cutting a fresh one (FR-014 "continuations for workspace preparation"); covered by the loop test's rework-prompt assertions in T010.

**Checkpoint**: US1 fully functional — the happy fail→triage→route→rework→success loop passes end-to-end.

---

## Phase 4: User Story 2 - Rework loops are hard-capped with human fallback (Priority: P2)

**Goal**: Deterministic pipeline code caps rework cycles (default 2) and escalates to a human task on budget exhaustion, invalid target, orchestrator failure, or a non-orchestrator routing attempt — never trusting the model.

**Independent Test**: Drive a ticket through the max rework cycles → next failure yields a human task and no triage run; complete a triage with an invalid target → overridden to a human task.

### Tests for User Story 2 (MANDATORY — Constitution VI) ⚠️

- [X] T022 [P] [US2] Integration test `test/integration/orchestrator-routing-guards.integration.spec.ts`: budget-exhausted failure → non-blocking human task + no triage (AC US2-1); invalid/disabled/orchestrator target → override to human task with reason (AC US2-2); valid `routed` but budget raced → override (AC US2-3); orchestrator run `failed`/`timed_out` → human task + no re-triage (AC US2-4); orchestrator `needs_human` → human task via the existing mechanism with NO ticket transition (FR-011).
- [X] T023 [P] [US2] Unit test in `libs/pipeline/src/pipeline.service.spec.ts`: a `routed` report from a non-orchestrator agent is treated as a failure with the invalid outcome noted in the comment (AC US2-5, FR-002).

### Implementation for User Story 2

- [X] T024 [US2] In `libs/pipeline/src/pipeline.service.ts`: budget guard — when the rework budget is exhausted or no enabled orchestrator exists, create a non-blocking human task instead of a triage run and record `cycle_limit`/`no_orchestrator` in the marker (FR-005, D6).
- [X] T025 [US2] In `libs/pipeline/src/pipeline.service.ts`: override path — a `routed` decision with an invalid target (missing/disabled/orchestrator/other-workspace) or exhausted budget becomes a non-blocking human task carrying the task text + override reason (FR-009).
- [X] T026 [US2] In `libs/pipeline/src/pipeline.service.ts`: orchestrator-run failure — when an orchestrator run itself `failed`/`timed_out`, create no second triage run and a human task describing the orchestrator failure (FR-010, "the triager is never triaged").
- [X] T027 [US2] In `libs/pipeline/src/pipeline.service.ts`: reject `routed` from a non-orchestrator agent as a failure and note the invalid outcome in the Jira comment (FR-002).
- [X] T028 [US2] Extend `libs/human-tasks/src/human-task.service.ts` to create the non-blocking (`blocking=false`) human tasks used by the triage-limit, override, and orchestrator-failure paths (FR-005/009/010).

**Checkpoint**: US1 + US2 both work — no ticket exceeds its rework max; all fallback paths land in the Human Queue.

---

## Phase 5: User Story 3 - Human resolves a blocked ticket by choosing which agent resumes (Priority: P2)

**Goal**: The Human Queue resolve flow accepts an optional target agent; the resumed run is created for the chosen agent with the question + answer injected via the handoff section, replacing the legacy instruction append.

**Independent Test**: Park a run via a blocking human task, resolve choosing a different agent → new run belongs to the chosen agent, ticket at its running status, prompt contains the task title/details + operator answer.

### Tests for User Story 3 (MANDATORY — Constitution VI) ⚠️

- [X] T029 [P] [US3] Integration test `test/integration/human-resume-picker.integration.spec.ts`: resolve with no `target_agent_id` → original agent (AC US3-1); with a different enabled agent → new run for it, attempt restarts at 1, ticket at chosen agent's running status (AC US3-2); non-existent/disabled/other-workspace id → 400 and nothing changes (AC US3-3).
- [X] T030 [P] [US3] Unit test in `libs/pipeline/src/handoff.spec.ts`: human-resume kind renders the task title, details, and operator answer verbatim (SC-004, FR-012).

### Implementation for User Story 3

- [X] T031 [US3] Extend `packages/contracts/src/resolve-human-task.schema.ts` with optional `target_agent_id`; re-export via `packages/contracts/src/index.ts` (FR-015, D11).
- [X] T032 [US3] In `libs/human-tasks/src/resume.service.ts`: accept optional target agent (validate exists ∧ enabled ∧ same workspace, else reject with nothing changed), create the resumed run for that agent with attempt numbering restarted, and write a `human-resume` trigger referencing the human task + parked run (FR-015/016).
- [X] T033 [US3] Add the `human-resume` handoff kind (task title/details + operator answer) to `libs/pipeline/src/handoff.ts` (FR-012).
- [X] T034 [US3] In `apps/worker/src/claude-cli-run.processor.ts`: replace the legacy `instructionWithResumeAnswer` append with the handoff section for the `human-resume` source (FR-014).
- [X] T035 [US3] Expose the `workspace` reference on Human Queue list items in the backend human-tasks query/controller so the UI selector can fetch the workspace's agents (`libs/human-tasks/` + `apps/backend/src/dashboard/`) (FR-017).
- [X] T036 [P] [US3] Add the agent selector to the blocking-resume panel in the Human Queue view (`apps/web/src/views/…HumanQueue`): lists the workspace's enabled non-orchestrator agents, original agent preselected (FR-017).
- [X] T037 [P] [US3] Extend the web API client (`apps/web/src/api/…`) to send `target_agent_id` on resolve.

**Checkpoint**: US1 + US2 + US3 work — operators pick any worker agent and the Q&A reaches the resumed run's prompt.

---

## Phase 6: User Story 4 - Orchestrator agent exists on every workspace and is centrally configurable (Priority: P3)

**Goal**: Every workspace gets a non-deletable "brigadir" orchestrator (wizard, yaml seed, startup backfill) on a cheap no-repo executor profile; a General settings section holds the default instruction copied in at creation.

**Independent Test**: Create a workspace → "brigadir" exists with the default instruction; change the default, create another → new default used, existing untouched; delete attempt → 409.

### Tests for User Story 4 (MANDATORY — Constitution VI) ⚠️

- [X] T038 [P] [US4] Integration test `test/integration/orchestrator-lifecycle.integration.spec.ts`: wizard create seeds "brigadir" (never poll-triggered, default instruction copied — AC US4-1); startup backfill inserts one for a pre-existing workspace lacking it (AC US4-2); delete via API → 409 while instruction/enabled edits succeed (AC US4-3); changing the default then creating a workspace uses the new default and leaves existing orchestrators unchanged (AC US4-4, SC-006).
- [X] T039 [P] [US4] Integration test `test/integration/global-settings.integration.spec.ts`: `GET/PUT /api/general-settings` round-trips `default_orchestrator_instruction` (FR-021).

### Implementation for User Story 4

- [X] T040 [P] [US4] Create `seedOrchestratorAgent(db, workspaceId)` helper (insert-if-absent on `UNIQUE(workspace_id, name='brigadir')`, `is_orchestrator=true`, `trigger_status/trigger_jql=NULL`, inert status placeholders) and ensure the dedicated cheap no-repo executor profile exists (`libs/database/` or `libs/app-config/`, reusing the executor-backfill pattern) (FR-018, D10).
- [X] T053 [US4] Implement the no-repo run mode the "no repository workspace" profile claims (plan.md Constitution V check depends on it): in `libs/executors/src/claude-cli/claude-cli.executor.ts`, when the agent's behavior requests no workspace (e.g. `behavior.workspace_mode: 'none'`), skip repo resolution/worktree `prepare()` and run from a scratch temp dir (wrapper file + cwd), skipping worktree cleanup/`worktree_path`; without this, triage runs on repo-configured workspaces would still clone and expose git credentials (FR-018, Constitution V).
- [X] T041 [US4] Call `seedOrchestratorAgent` on wizard workspace creation in `apps/backend/src/dashboard/workspaces.controller.ts`, reading the default instruction from `global_settings` (fallback to the built-in constant) (FR-018/022).
- [X] T042 [P] [US4] Call `seedOrchestratorAgent` on yaml workspace seeding in `libs/app-config/src/config-seeder.ts` (FR-018).
- [X] T043 [P] [US4] Create `apps/backend/src/dashboard/orchestrator-backfill.service.ts` running `OnApplicationBootstrap`, iterating existing workspaces and inserting-if-absent (FR-018, D10).
- [X] T044 [US4] In `apps/backend/src/dashboard/agents.controller.ts`: reject deletion of an `is_orchestrator` agent with 409, and expose/accept the `description` field on agent read/write (FR-019/020).
- [X] T045 [US4] Create `apps/backend/src/dashboard/general-settings.controller.ts` with `GET/PUT /api/general-settings` reading/writing `default_orchestrator_instruction` in `global_settings` (FR-021).
- [X] T046 [P] [US4] Add the "General" tab to the platform Settings view (`apps/web/src/views/…SettingsView`) with the default orchestrator instruction text field + save, plus its web API client (FR-021).
- [X] T047 [P] [US4] In `apps/web/src/components/…AgentForm`: add the `description` field and hide the delete action for the orchestrator agent (FR-019/020).

**Checkpoint**: All user stories independently functional — orchestrator is zero-setup and centrally configurable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and end-to-end validation across stories.

- [X] T048 [P] Update `docs/architecture.md` §3 (schema deltas: `agents.description`/`is_orchestrator`, `global_settings`) and §6 (`routed` report outcome + routing payload) (FR-024).
- [X] T049 [P] Append the iteration entry (decisions, dedup/idempotency notes) to `docs/progress.md`.
- [X] T050 Run the quickstart.md validation path: `pnpm typecheck && pnpm lint && pnpm test` then `pnpm test:integration` (Docker), confirming Scenarios 1–4 green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (DB migration, trigger/report/settings contracts, settings accessors).
- **User Stories (Phase 3–6)**: All depend on Foundational.
  - US1 (P1) is the MVP and introduces `handoff.ts`, the pipeline triage/route branches, and processor injection.
  - US2 (P2) extends the same `pipeline.service.ts` completion path — sequential with US1 (same file), independently testable.
  - US3 (P2) touches resume/handoff/UI — largely independent of US1/US2; it *extends* `handoff.ts` (adds the human-resume kind) and finalizes the claude-cli processor replacement.
  - US4 (P3) is seeding/settings/UI — independent of US1–US3 (relies only on Foundational schema).
- **Polish (Phase 7)**: After all desired stories.

### Within Each User Story

- Tests written first and failing before implementation.
- Contracts/models before services; services before pipeline branches and endpoints; core before UI.

### Parallel Opportunities

- Foundational: T002, T003, T004, T005, T007, T008 are [P] (distinct files); T006 precedes T007.
- US1: T009/T010/T011 tests in parallel; T013, T018, T019, T051 in parallel; T016/T017 are sequential (same `pipeline.service.ts`), after T014/T015; T052 follows T021 (same processor file). T053 (US4) is required before running live claude_cli triage runs — mock-based US1 tests don't need it.
- US2: all impl tasks share `pipeline.service.ts` (T024–T027 sequential); T028 [P]; tests T022/T023 in parallel.
- US3: T036/T037 [P]; T031→T032→T033→T034 sequential-ish across contract→service→handoff→processor.
- US4: T040, T042, T043, T046, T047 [P]; T041/T044/T045 touch distinct backend controllers.
- Cross-story: once Foundational is done, US4 can proceed fully in parallel with US1–US3 (no shared files).

---

## Parallel Example: User Story 1

```bash
# Tests first (all [P]):
Task: "Contract test report.schema.spec.ts — routed outcome/payload"
Task: "Integration test orchestrator-routing-loop.integration.spec.ts — full loop"
Task: "Unit test handoff.spec.ts — triage + rework kinds"

# Then parallel implementation pieces (distinct files):
Task: "rework-budget.ts derive cycle count"
Task: "mock.executor.ts routed scenario"
Task: "adf-composer.ts routed panel"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — blocks all) → 3. Phase 3 US1.
4. STOP and VALIDATE: the fail→triage→route→rework→success loop passes under the mock executor (SC-007).
5. Demo the closed loop.

### Incremental Delivery

1. Foundational ready.
2. US1 → the automated loop (MVP).
3. US2 → hard cap + human fallbacks (makes the loop safe to run unattended).
4. US3 → human-queue agent picker.
5. US4 → seeding + central default (zero-setup).
Each story adds value without breaking the previous.

### Notes

- [P] = different files, no dependency on incomplete tasks.
- The `pipeline.service.ts` completion path is a serialization point across US1/US2 — coordinate those tasks.
- Constitution guardrails: three dedup layers on every enqueue (II), system-only Jira writes via the per-issue queue (III), secret scrubbing on the routing task (V), and replay-safe markers (II, SC-001).

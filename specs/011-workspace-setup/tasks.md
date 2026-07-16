# Tasks: Workspace Setup by the Orchestrator ("Generate agents") + Read-Only Jira Tools

**Input**: Design documents from `/specs/011-workspace-setup/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D17), data-model.md, contracts/, quickstart.md

**Tests**: MANDATORY for everything below except the US4 web-rendering tasks (Constitution VI —
all other phases are pipeline logic: enqueue/dedup, callbacks, report processing, human-task
flows). Test tasks are folded into their implementation tasks ("+ tests") and land in the same
commit as the code they cover.

**Organization**: By user story (spec.md), after a foundational phase that relaxes the
ticket-required invariant every story leans on.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 for story phases; setup/foundational/polish have no label

## Phase 1: Setup

No setup tasks — existing monorepo; all structure already in place (plan.md Project Structure).

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: nullable-ticket plumbing + trigger vocabulary. Blocks all stories (US2 only via T001).

- [X] T001 [P] Extend trigger vocabulary in `packages/contracts/src/trigger-event.schema.ts`: `TRIGGER_SOURCES += 'workspace-setup'`, `MOCK_SCENARIOS += 'team','team_invalid'`; update `trigger-event.schema.spec.ts` (D1/D15)
- [X] T002 [P] Make `tkt` claim optional in `packages/contracts/src/run-token.ts` (`RunTokenClaims.tkt?`); adjust its spec — guard behavior unchanged (D4)
- [X] T003 [P] Nullable ticket in dashboard contracts: `packages/contracts/src/runs.schema.ts` (`RunListItem.ticket`/card ticket → `.nullable()`, `RunListQuerySchema += source?`), `packages/contracts/src/human-queue.schema.ts` (`HumanQueueItem.ticket` → `.nullable()`); update contract specs (D16)
- [X] T004 Drizzle schema: drop `.notNull()` on `ticketId` in `libs/database/src/schema/runs.ts` and `libs/database/src/schema/human-tasks.ts`; add partial unique index `runs_one_active_setup (workspace_id) WHERE status IN ('queued','running','awaiting_human') AND ticket_id IS NULL` (D2/D3)
- [X] T005 Migration `drizzle/0005_workspace_setup.sql` (two `DROP NOT NULL` + the partial index) + `drizzle/REVIEW-0005_workspace_setup.md` reviewed against `docs/architecture.md` §3 (rule 5)
- [X] T006 Extend `test/integration/db-constraints.spec.ts`: ticketless insert allowed on runs/human_tasks; second active ticketless run per workspace rejected (23505); `runs_one_active` still enforces ticketed pairs
- [X] T007 `libs/runs/src/run-trigger.service.ts`: `ticketId` param optional (insert NULL), `'workspace-setup'` joins the BullMQ-dedup skip set next to `CONTINUATION_SOURCES`; 23505 from either index → `{deduplicated:true}`; unit tests (D1/D2)
- [X] T008 [P] `libs/executors/src/agent-executor.interface.ts`: `RunContext.ticket` nullable; `libs/executors/src/claude-cli/wrapper.ts`: ticketless workspace-setup header branch (skip ticket/description/feature-context sections); unit tests for both wrapper branches (D4)
- [X] T009 Worker processors go ticket-optional: `apps/worker/src/run.processor.ts` and `apps/worker/src/claude-cli-run.processor.ts` — `leftJoin(tickets)` in `load()`, null-ticket `RunContext`, skip `fetchTicketDetail`/feature-context, mint JWT without `tkt` for ticketless runs; unit/integration coverage via existing processor specs (D2/D4)
- [X] T010 `libs/human-tasks/src/human-task.service.ts`: `createNonBlocking`/`createFromRequest` accept null ticket; `transitionAndComment` skips Jira entirely when the task is ticketless (park/insert still happen); unit tests (D12)
- [X] T011 `apps/backend/src/dashboard/runs.controller.ts`: list+count+card switch to `leftJoin(tickets)`, serialize `ticket: null` (no deep link; history join skipped for null), add `source` query filter (`trigger_event->>'source'`); integration tests: ticketless run appears in list/total, card 200 with `ticket:null`, `source=workspace-setup` filter (D11/D16)
- [X] T012 `apps/backend/src/dashboard/human-tasks.controller.ts`: `leftJoin(tickets)` (global + `?workspace=` variants), serialize `ticket: null`; integration test: ticketless task listed and resolvable (D16)

**Checkpoint**: ticketed pipeline behavior byte-for-byte unchanged (existing suites green);
ticketless rows storable, listable, and triggerable.

---

## Phase 3: User Story 1 — One action turns an empty workspace into a reviewable team (P1) 🎯 MVP

**Goal**: create-paused workspace → Generate agents → setup run → `team` report → agents enabled + review task, workspace still paused → start switch.

**Independent test**: quickstart Scenario A end-to-end under the mock executor (`test/integration/workspace-setup.integration.spec.ts`).

- [X] T013 [P] [US1] Report contract: `packages/contracts/src/report.schema.ts` — `REPORT_OUTCOMES += 'team'`, `TeamAgentSchema`/`ReportTeamSchema` (bounds per contracts/report-schema.md), superRefine `team ⇔ payload`; contract tests incl. JSON-Schema round-trip (D9)
- [X] T014 [P] [US1] Scrubbing: `libs/callback/src/callback.service.ts` `scrubReport` += `team.agents[].description/instruction` (identifiers exempt); unit test (D10)
- [X] T015 [US1] Proposal validator: new `libs/pipeline/src/setup-apply.service.ts` — all-or-nothing checks (names unique vs proposal ∪ existing ∪ orchestrator; statuses via `StatusesService.get({refresh:true})` + `lintAgent` `status_absent`; executor name → existing ∧ enabled profile; `duplicate_trigger` across proposal ∪ existing enabled), path-qualified issue list; unit tests per rule (FR-015/D9)
- [X] T016 [US1] Atomic applier in the accept path: `SetupApplyService.apply` — ONE transaction inserting N agents (`enabled=true`, `AgentsController`-equivalent insert shape) + review human task (`kind='review'`, `blocking=false`, `ticket_id NULL`, `run_id`, title "Team assembled — review the workspace") + guarded finalize `succeeded`; wire into `libs/runs/src/runs.service.ts` `finalizeWithReport` (`team` accepted → succeeded) and `libs/callback/src/callback.service.ts` `complete()` (business-invalid → 422 with issues, run stays running); recast `team` from non-setup runs as failure (FR-014); integration tests: valid apply atomicity, 422 repair loop leaves zero agents (D9/D10)
- [X] T017 [US1] Pipeline completion: `libs/pipeline/src/pipeline.service.ts` orchestrator branch gains `workspace-setup` case — completion marker `{setup:'applied'|'failed', agents_created?}` only (no Jira writes, no triage); unit test for marker payloads (D10)
- [X] T018 [US1] Setup handoff: `libs/pipeline/src/handoff.ts` `workspace-setup` branch — project digest (workspace row, `settings.repositories`, enabled `executors`, `StatusesService` statuses), protocol lines, resume Q&A block; size-bounded, best-effort; unit tests incl. degraded digest (D13, contracts/handoff-setup.md)
- [X] T019 [US1] Mock scenario `team`: `libs/executors/src/mock.executor.ts` emits a valid team report (roster threaded via agent `behavior`, mirroring `routed`'s `route_target` precedent); thread `mock_scenario` into the setup trigger event where triage does (`mockScenarioOf`) (D15)
- [X] T020 [US1] Paused-by-default: `apps/backend/src/dashboard/workspaces.controller.ts` `create()` writes `settings.enabled=false`; `libs/app-config/src/config-seeder.ts` same for newly seeded workspaces (existing rows untouched); integration test: fresh workspace excluded from a reconcile pass (FR-001/D14, SC-002)
- [X] T021 [US1] Generate endpoint: `POST /api/workspaces/:id/generate-agents` in `workspaces.controller.ts` — ordered preconditions → `404/409` (`worker_agents_exist`/`no_orchestrator`/`setup_run_active`) or `202 {run_id}` via `RunTriggerService.trigger({ticketId:null, …})`; integration tests per precondition (contracts/generate-agents-api.md)
- [X] T022 [P] [US1] Web plumbing: `apps/web/src/api/workspaces.ts` generate mutation + `apps/web/src/composables/useWorkspaces.ts` `useGenerateAgents`; `apps/web/src/api/runs.ts` + `composables/useRuns.ts` accept `source` filter
- [X] T023 [US1] Web button: `apps/web/src/views/AgentsList.vue` — **Generate agents** in the header when the roster is orchestrator-only; active setup run (via `useRuns(…, {source:'workspace-setup'})` poll) → progress hint linking to the run card; MSW test for the three states (D11)
- [X] T024 [US1] Full-loop integration test `test/integration/workspace-setup.integration.spec.ts` (quickstart Scenario A): create → paused → generate → mock `team` → agents+review task+succeeded+marker → still paused → resolve+start → reconcile picks up trigger-status tickets (SC-001/002/008)

**Checkpoint**: MVP demonstrable end-to-end under the mock executor.

---

## Phase 4: User Story 2 — Any agent run can read Jira mid-run (P2)

**Goal**: three read-only tools on the callback channel for every callback-wired run.

**Independent test**: quickstart Scenario C against the mock Jira layer.

- [X] T025 [P] [US2] Tool input schemas in `packages/contracts/src/callback-tools.schema.ts`: `GetProjectOverviewSchema`/`SearchTicketsSchema`/`GetTicketSchema` (`.strict()`, bounds per contracts/jira-read-tools.md); contract tests (D5)
- [X] T026 [US2] Jira client reads: `libs/jira/src/jira-client.interface.ts` + `basic-auth-jira.client.ts` — `getIssueDetail(key)` (summary/description/status/type/labels/links/comments) and `searchIssues(jql, fields, maxResults≤50)`; issue-type names extracted from the `/project/{key}/statuses` response; unit tests for mappers (D7)
- [X] T027 [US2] Read service: new `libs/callback/src/jira-read.service.ts` — server-side JQL composition (`project = key` + `sprint in openSprints()` for scrum + structured filters; raw JQL never accepted), project-key scope check for `get_ticket` (403 `out_of_scope`), truncation policy (desc ≤4000, comment ≤1500 ×20 newest-first, search ≤50, `truncated` flags); unit tests incl. scope escape attempts (D6/D8)
- [X] T028 [US2] Endpoints: `libs/callback/src/callback.controller.ts` — `GET :runId/jira/overview`, `POST :runId/jira/search`, `GET :runId/jira/tickets/:key` under the existing `RunTokenGuard`, Jira via `JiraClientFactory.forWorkspace(run.workspaceId)`; extend `test/integration/mock-jira.ts` with overview/search/detail fixtures; integration tests: happy paths, 403 scope, 401 foreign token, 409 finished run, truncation, worker-run token parity (SC-005)
- [X] T029 [US2] MCP server: `packages/mcp-server/src/main.ts` `TOOL_DEFS` + `switch` dispatch += 3 tools (BOTH hardcoded spots); `packages/mcp-server/src/tools.ts` handlers (GET support alongside `postWithRetry`, 4xx → tool error verbatim); unit tests (D5)
- [X] T030 [US2] Wrapper prose: `libs/executors/src/claude-cli/wrapper.ts` `callbackToolsSection` gains the "read tools are eyes, not voice" paragraph; setup handoff protocol references them; snapshot/unit test update

**Checkpoint**: any run token can read scoped Jira; no write surface exists.

---

## Phase 5: User Story 3 — Guards: no duplicates, no partial teams, loud failures (P2)

**Goal**: the one-click action is safe under races, bad proposals, crashes, and questions.

**Independent test**: quickstart Scenario B + D(1).

- [X] T031 [US3] Concurrent-generate race integration test: two parallel `POST generate-agents` → exactly one 202 + one 409 `setup_run_active`; exactly one active setup run (endpoint check + `runs_one_active_setup`) (SC-003, FR-004)
- [X] T032 [US3] Mock scenario `team_invalid` in `libs/executors/src/mock.executor.ts` (proposal with a bogus status; after the 422, exits without a valid report); integration test: 422 carries `status_absent` issues, ZERO agents, run ends `failed` via fail-closed, ticketless failure human task, NO triage run (SC-004, FR-017)
- [X] T033 [US3] Replay idempotency integration test: re-invoke `onRunFinished` for an applied setup run → marker no-op, no duplicate agents/review task (SC-007, FR-019)
- [X] T034 [US3] Duplicate-name-vs-existing-agent integration test: proposal naming an existing agent (and one naming `brigadir`) → clean 422, not a 500 from `agents_workspace_name` (FR-015)
- [X] T035 [US3] Resume of a parked setup run: `libs/human-tasks/src/resume.service.ts` — parked run with `trigger_event.source==='workspace-setup'` resumes as a NEW `workspace-setup` run carrying `human_task_id`+`resolution` (never answer-triage); `target_agent_id` on a ticketless task → 422 `invalid_target`; integration test: blocking question → resolve → new setup run whose handoff renders Q&A (FR-020/D12)
- [X] T036 [US3] Setup-failure semantics: orchestrator-failure human task gets setup-specific wording ("Workspace setup failed…", last validation issues when present); assert `decideTriage` unreachable for ticketless runs; integration test failed/timed-out setup run (FR-006, US3-AS3)

**Checkpoint**: all SC-003/004/007 scenarios green; the button is safe to hand to users.

---

## Phase 6: User Story 4 — Ticketless runs are first-class in the UI (P3)

**Goal**: null-ticket entries render labeled, linkless, and unbroken. (Backend serialization
already landed in T011/T012 — this phase is web-only; MSW tests, lighter coverage permitted.)

- [X] T037 [P] [US4] `apps/web/src/views/Runs.vue`: `ticket === null` → static **Workspace setup** label (no `<a>`); ticketless fixtures in `apps/web/test/handlers.ts`; update `runs-table.spec.ts`
- [X] T038 [P] [US4] `apps/web/src/views/RunCard.vue`: null-ticket header variant (label, no Jira link, summary omitted); update `run-card.spec.ts`
- [X] T039 [P] [US4] `apps/web/src/components/HumanQueue/HumanTaskRow.vue` + `HumanTaskDrawer.vue`: null-ticket label; `apps/web/src/views/HumanQueue.vue`: hide `ResumeAgentPicker` for ticketless tasks; update `human-queue.spec.ts` + `resume-agent-picker.spec.ts` (D12/D16)
- [X] T040 [P] [US4] Workspace wizard post-create hint ("workspace starts paused — generate or add agents, then Start") in the wizard completion step (`apps/web/src/views/…Wizard…`); workspace-list spec asserts a fresh workspace renders Paused

**Checkpoint**: quickstart Scenario D(2) passes; no broken links anywhere.

---

## Phase 7: Polish & cross-cutting

- [X] T041 [P] Docs: `docs/architecture.md` §3 (nullable ticket refs + `runs_one_active_setup`), §5 (read tools in the callback protocol), §6 (`team` outcome) (D17)
- [X] T042 [P] Docs: `docs/plan-internal.md` feature-011 iteration row (slot vs 12–13 noted for owner); `docs/progress.md` journal entry at checkpoint
- [X] T043 Full gates: `pnpm typecheck && pnpm lint && pnpm test` + `pnpm test:integration`; fix fallout; quickstart Scenario E (live smoke) left as a post-merge manual gate

---

## Dependencies & execution order

```
Phase 2 (T001–T012) ──▶ US1 (T013–T024) ──▶ US3 (T031–T036) ──▶ Polish (T041–T043)
        │                                        ▲
        ├────────────▶ US2 (T025–T030) ──────────┘   (US3's team_invalid test needs US1's accept path;
        └────────────▶ US4 (T037–T040)               US2 independent after T001; US4 independent after T011/T012)
```

- Within Phase 2: T001–T003 parallel; T004→T005→T006; T007–T012 after T004 (T008 parallel to T007).
- Within US1: T013/T014/T022 parallel early; T015→T016→T017; T018/T019 parallel; T024 last.
- US2 can proceed in parallel with US1 after T001 (different files throughout).
- MVP scope = Phase 2 + US1 (T001–T024): demonstrable generate→team→review loop on mock.

## Implementation strategy

Deliver in PR-sized commits mirroring the phases: foundational plumbing first (existing suites
must stay green — the strongest regression signal for the nullable-ticket change), then the US1
loop as the MVP checkpoint, then US2 tools, US3 guards, US4 polish. Every pipeline task carries
its tests in the same commit (Constitution VI); `docs/progress.md` entry closes the iteration.

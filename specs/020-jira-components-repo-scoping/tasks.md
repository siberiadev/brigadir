# Tasks: Per-Ticket Repository Scoping via Jira Components

**Input**: Design documents from `/specs/020-jira-components-repo-scoping/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: MANDATORY — scope resolution, the gate, parking, and the resume round trip are pipeline logic (constitution Principle VI; CLAUDE.md rule 4). Test tasks are included for every story below; only the US3 web-UI toggle itself is UI-light.

**Organization**: Grouped by user story (spec.md priorities). Settled decisions D1–D5 ([design-brief.md](design-brief.md)) and research decisions R1–R10 ([research.md](research.md)) are referenced inline — do not re-litigate them during implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 per spec.md

## Path Conventions

pnpm monorepo per plan.md: `packages/contracts`, `libs/*`, `apps/backend`, `apps/worker`, `apps/web`, integration tests in `test/integration/` (vitest + testcontainers; unit specs colocated with sources).

---

## Phase 1: Setup

No project scaffolding needed — existing monorepo. One guard task:

- [x] T001 Verify baseline is green before touching code: run `pnpm typecheck && pnpm lint && pnpm test` at repo root (worktree `claude/jira-components-repo-scoping-fe5fca`); record any pre-existing failures so they are not attributed to this feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Thread `components` from Jira to the executor and register the `ticket_scoping` settings key — every story reads these types. Contracts: [jira-getissue-components.md](contracts/jira-getissue-components.md), [workspace-settings-flag.md](contracts/workspace-settings-flag.md) §1.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 Extend `getIssue()` to request/return components (R2): add `components` to the fields param and return type in `libs/jira/src/basic-auth-jira.client.ts:157` (map `fields.components[].name` → `string[]`, absent ⇒ `[]`); update the contract doc-comment and signature in `libs/jira/src/jira-client.interface.ts:34` and the delegate in `libs/jira/src/lazy-jira.client.ts:69`
- [x] T003 [P] Update Jira client unit tests for the new `getIssue` shape: `libs/jira/src/basic-auth-jira.client.spec.ts` (fields param includes `components`; mapping incl. absent field ⇒ `[]`) and `libs/jira/src/lazy-jira.client.spec.ts` (delegate passthrough)
- [x] T004 Update the integration Jira double to serve components: `test/integration/mock-jira.ts` — `getIssue` returns configured component names per ticket (default `[]`), settable per test
- [x] T005 Extend `TicketDetail` with `components: string[] | null` in `apps/worker/src/ticket-detail.ts`: success path maps `issue.components`; the existing non-fatal catch returns `components: null` (null ⇔ fetch failed — R5, load-bearing vs `[]`)
- [x] T006 Extend `RunContext.ticket` with `components: string[] | null` in `libs/executors/src/agent-executor.interface.ts:23` (doc-comment the null semantics; `ticket: null` ticketless case unchanged)
- [x] T007 Populate `components` in both producers (R1/R9): `apps/worker/src/claude-cli-run.processor.ts:384` (`buildContext` from `detail`) and the mock-path equivalent in `apps/worker/src/run.processor.ts:233` (type-complete; no behavior change)
- [x] T008 [P] Add `ticket_scoping: z.boolean().optional()` to `WorkspaceSettingsSchema` in `packages/contracts/src/jira.types.ts:112` (comment: feature 020, D2b — ABSENT ⇒ OFF, jsonb value only, no DDL) and a `getTicketScoping(db, workspaceId)` accessor (absent ⇒ `false`) in `libs/database/src/workspace-settings.ts` following the `getReworkMax` pattern
- [x] T009 Run `pnpm typecheck && pnpm lint && pnpm test` — foundational plumbing compiles and existing suites stay green (components field is additive everywhere)

**Checkpoint**: Components reach `RunContext.ticket`; the flag key exists. User stories can begin.

---

## Phase 3: User Story 1 — Runs provision only the repositories the ticket names (Priority: P1) 🎯 MVP

**Goal**: In a flag-ON workspace, the ticket's components intersect the agent's base set (D1); non-repo components filter silently (D3); the run clones/mounts only the effective subset. (Undeterminable outcomes throw in this story — the run fails closed; the operator-friendly parking lands in US2.)

**Independent Test**: Integration — multi-repo agent, ticket components naming a strict subset ⇒ only that subset's worktrees exist; components never widen; "Design"-style names ignored. Unit — decision-table rows 1, 7–10 of [contracts/scope-resolution.md](contracts/scope-resolution.md).

### Tests for User Story 1 (write first, watch them fail) ⚠️

- [x] T010 [US1] Create `libs/executors/src/claude-cli/scope-ticket.spec.ts` with decision-table tests (contract rows 1, 3, 4–6 classification, 7, 8, 9, 10): flag off ⇒ full base set `gate:'off'`; unreadable ⇒ `components_unreadable`; the three undeterminable cases classified in D1/D3 order; subset match; ignored non-repo names; never-widens; case/whitespace-insensitive trimmed matching (FR-016); duplicates collapse; declaration order preserved — assert full `NarrowingDecision` payloads (the WHOLE pure function is specified here; US2/US4 only consume outcomes)
- [x] T011 [P] [US1] Create `test/integration/claude-cli-scoping.spec.ts` (model: `claude-cli-repository.spec.ts`, harness `claude-cli-harness.ts`, double from T004): flag ON + components subset ⇒ worktrees ONLY for subset (SC-001); mix with non-repo name ⇒ ignored, run proceeds (FR-004); components ⊃ agent scope ⇒ intersection only, never widens (FR-003); unscoped agent in multi-repo workspace ⇒ narrowed the same way (Story 1 scenario 4)

### Implementation for User Story 1

- [x] T012 [US1] Implement `narrowByTicketComponents()` + `RepositoryScopeUndeterminableError` + `NarrowingDecision`/`NarrowResult` types in new `libs/executors/src/claude-cli/scope-ticket.ts` per [contracts/scope-resolution.md](contracts/scope-resolution.md) — pure, dependency-free, no imports from executor/DB (R10); T010 goes green
- [x] T013 [US1] Wire the gate into the normal-run branch of `resolveClaudeCliConfig()` in `libs/executors/src/claude-cli/claude-cli.executor.ts:611` (R4 flow steps 3–7 in plan.md): read `ticket_scoping` off the settings row already loaded in `resolveRepositories` (ONE read path — lazy, runtime); pass `ctx.ticket?.components ?? null` down to the resolution point (adjust `run()`→config plumbing as needed); `resolved` ⇒ use narrowed repos; `undeterminable` ⇒ throw the typed error BEFORE any clone/worktree call; `components_unreadable` ⇒ throw plain `Error` naming ticket + active gate (R5); setup branch at `:598-606` untouched (D5); ticketless/`noRepo` runs bypass (FR-014)
- [x] T014 [US1] Extend executor unit tests in `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`: flag ON narrowing applied at the call site; setup run never narrows (D5); ticketless run bypasses; typed error propagates before worktree creation
- [x] T015 [US1] Run T011 integration spec to green (`pnpm test:integration -- claude-cli-scoping`); then full `pnpm typecheck && pnpm lint && pnpm test`

**Checkpoint**: Narrowing works end-to-end (flag ON); undeterminable scope fails the run (closed) with a typed error awaiting US2's parking.

---

## Phase 4: User Story 2 — Undeterminable scope parks the run with an actionable question (Priority: P2)

**Goal**: The three D2 cases park to the human queue with distinct question texts via the existing guarded park; resolving the task yields a fresh run that re-scopes (FR-011).

**Independent Test**: Integration — each D2 condition parks `awaiting_human` with its own `kind:'blocker'` title, Jira double sees blocked transition + comment, zero clones; park→set-components→resolve ⇒ successor run mounts the subset.

### Tests for User Story 2 (write first) ⚠️

- [x] T016 [US2] Add park-case coverage to `test/integration/claude-cli-scoping.spec.ts`: for each of no-components / only-non-repo-components / disjoint-from-scope — run parks `awaiting_human`; `human_tasks` row `kind:'blocker'`, `blocking:true`, title matches the case's normative text ([contracts/scope-resolution.md](contracts/scope-resolution.md) §Question texts, distinct across cases — SC-002); Jira double received blocked transition + question comment; NO worktree/clone happened (FR-008); park respects the `status='running'` guard (idiom: `callback-awaiting-human-noclobber.spec.ts`); components-unreadable (double's `getIssue` throws) ⇒ run `failed` with diagnostics, no park, no full-set clone (R5)
- [x] T017 [P] [US2] Add the round-trip test (park → human sets components on the Jira double → resolve via the existing resolve endpoint): parked run `superseded`, fresh `queued` run re-reads components and mounts only the named repo (FR-011, SC-004) — in `test/integration/claude-cli-scoping.spec.ts` or alongside `human-resume-picker.integration.spec.ts`, following its resolve-flow setup

### Implementation for User Story 2

- [x] T018 [US2] Compose the three case-specific question texts (title + details) from display-safe fields only (ticket key, components seen, workspace/agent repo names — FR-009, feature-010 system-composed precedent) — as a small pure helper in `libs/executors/src/claude-cli/scope-ticket.ts` or beside the catch in the processor; unit-cover the wording distinctness in `scope-ticket.spec.ts`
- [x] T019 [US2] Import `HumanTasksModule` into `apps/worker/src/app.module.ts` (providers resolve against the worker's existing global DRIZZLE/JIRA_CLIENT/queue providers — R4; note the multi-import precedent comment style)
- [x] T020 [US2] Catch `RepositoryScopeUndeterminableError` in `apps/worker/src/claude-cli-run.processor.ts` BEFORE the generic `catch → exitStatus:'crashed'` mapping (around `:188`): call `HumanTaskService.createFromRequest(runId, { kind:'blocker', blocking:true, title, details })`, log the case, and return WITHOUT finalizing the run (guarded park owns the status; CLAUDE.md rule 7 — never clobber callback state); clear timers via the existing `finally`
- [x] T021 [US2] Run T016/T017 to green; full `pnpm test:integration`

**Checkpoint**: Fail-closed loop complete — park, distinct questions, resume-rescope round trip.

---

## Phase 5: User Story 3 — Per-workspace opt-in, exact status quo when OFF (Priority: P2)

**Goal**: `ticket_scoping` togglable per workspace via API + dashboard; flag OFF (default) is byte-identical to today everywhere (FR-005, SC-003). Contract: [workspace-settings-flag.md](contracts/workspace-settings-flag.md) §2–4.

**Independent Test**: Integration — PUT/GET the flag round-trips; flag-off matrix (with/without components, deprecated field, repo-less, setup) shows zero behavioral diff and existing suites pass unmodified; two workspaces isolate (only the ON one narrows/parks).

### Tests for User Story 3 (write first) ⚠️

- [x] T022 [P] [US3] Extend `test/integration/workspace-settings.spec.ts`: PUT `ticket_scoping:true` round-trips into the settings blob and `WorkspaceResponse.ticket_scoping`; absent key serializes `false`; PUT without the field leaves it unchanged (merge-patch); `.strict()` still rejects unknown keys
- [x] T023 [P] [US3] Add the flag-off/back-compat matrix to `test/integration/claude-cli-scoping.spec.ts`: flag OFF (default) with components present ⇒ full base set, no narrowing, no park, NO scoping run event; without components ⇒ proceeds as today; deprecated `behavior.repository` agent unchanged; two-workspace isolation (ON narrows, OFF doesn't — Story 3 scenario 3); assert existing `claude-cli-repository.spec.ts` passes UNMODIFIED (SC-003 proxy)
- [x] T024 [P] [US3] Extend `packages/contracts/src/dashboard.schema.spec.ts` for the two additive fields (request optional, response boolean)

### Implementation for User Story 3

- [x] T025 [US3] Add `ticket_scoping` to `WorkspaceSettingsRequestSchema` (optional) and `WorkspaceResponseSchema` (boolean) in `packages/contracts/src/dashboard.schema.ts` with feature-006 `enabled`-style comments
- [x] T026 [US3] Pass the field through the settings PUT and serialize it in responses (absent ⇒ `false`) in `apps/backend/src/dashboard/workspaces.controller.ts` (+ its service/mapper if split), via the existing `patchWorkspaceSettings` merge-write
- [x] T027 [US3] Add the "Ticket repository scoping (Jira Components)" toggle to `apps/web/src/views/WorkspaceSettings.vue`, seeded from `WorkspaceResponse.ticket_scoping`, saved via the settings PUT — Element Plus switch beside the enable/pause toggle; follow UI conventions (no hardcoded brand colors, no icon hover animation)
- [x] T028 [US3] Run T022–T024 to green; `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`

**Checkpoint**: Rollout control done — one board can be enabled, watched, and rolled back without a deploy.

---

## Phase 6: User Story 4 — Narrowing never blocks: D2a skip + escape hatch + setup untouched (Priority: P3)

**Goal**: Single-repo base sets never gate (D2a); narrowed runs get the `.repos/<name>` self-clone note for excluded repos (D4/R8); setup runs byte-identical (D5).

**Independent Test**: Unit — decision-table row 2; wrapper snapshots. Integration — flag ON + single-repo base + no components ⇒ no park; setup run in a flag-ON workspace unchanged.

### Tests for User Story 4 (write first) ⚠️

- [x] T029 [P] [US4] Add D2a rows to `libs/executors/src/claude-cli/scope-ticket.spec.ts`: base set of 1 (agent-scoped or deprecated single-field) and of 0 (repo-less) ⇒ `resolved` as-is, `gate:'skipped_single_repo'`, regardless of components incl. `null` (contract row 2)
- [x] T030 [P] [US4] Extend `libs/executors/src/claude-cli/wrapper.spec.ts`: non-narrowed run renders byte-identical (snapshot unchanged); narrowed run lists each excluded repo (name + git URL) with the on-demand `.repos/<name>` clone note
- [x] T031 [P] [US4] Add to `test/integration/claude-cli-scoping.spec.ts`: flag ON, single-repo workspace, component-less ticket ⇒ run proceeds, no human task (FR-006); setup run in a flag-ON workspace keeps its one-element scope and never gates (FR-013, D5)

### Implementation for User Story 4

- [x] T032 [US4] D2a is implemented inside `narrowByTicketComponents()` (T012) — verify T029 passes against it; if T012 landed without the `baseRepos.length <= 1` early-return, add it here
- [x] T033 [US4] Extend the repo-list header in `libs/executors/src/claude-cli/wrapper.ts`: accept the excluded-repos list (plumbed from the executor's narrowing result) and render the `.repos/<name>` note ONLY when narrowing excluded ≥ 1 repo (R8); wire the parameter through `claude-cli.executor.ts` where the wrapper is composed
- [x] T034 [US4] Run T029–T031 to green

**Checkpoint**: Guard-rails proven — no pure-friction parks, no stranded narrow runs, setup untouched.

---

## Phase 7: User Story 5 — The narrowing decision is visible to operators (Priority: P3)

**Goal**: Every scoping-active resolution writes one `run_events` timeline row (`source:'repo-scoping'`, full `NarrowingDecision` payload — R6, FR-015); parked runs additionally identifiable by case.

**Independent Test**: Integration — matched, partially-ignored, parked, and skipped runs each yield an event whose payload reconstructs the decision (SC-005); flag-off runs yield NO event.

### Tests for User Story 5 (write first) ⚠️

- [x] T035 [US5] Add run-event assertions across the existing scenarios in `test/integration/claude-cli-scoping.spec.ts`: `gate:'passed'` with `components/matched/ignored/effective` on narrowed runs; `gate:'parked:<case>'` on each park; `gate:'skipped_single_repo'` on D2a; `gate:'failed:components_unreadable'` on R5; and NO `repo-scoping` event when the flag is off (T023 tightened)

### Implementation for User Story 5

- [x] T036 [US5] Insert the `run_events` row (`type:'log'`, payload `{ source:'repo-scoping', message, ...NarrowingDecision }` per data-model.md §5) at the resolution point in `libs/executors/src/claude-cli/claude-cli.executor.ts`, following the `setup-profile-fallback` insert precedent (`:680`); for the parked path the processor records it (it owns the catch — keep exactly ONE event per run); human-readable `message` one-liner for the timeline
- [x] T037 [US5] Run T035 to green; verify manually in the dashboard run timeline (quickstart.md §3 step 2) that the event renders legibly

**Checkpoint**: All five stories functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T038 [P] Append the feature-020 iteration entry to `docs/progress.md` (journal convention) — decisions applied (D1–D5, R5 fail-mode), files touched, test coverage added; note in the entry that `docs/architecture.md` §3 required NO update (no DDL)
- [x] T039 [P] Re-read new/changed doc-comments for accuracy against final code (scope-ticket contract comment, `RunContext.ticket.components` null semantics, flag comment in `jira.types.ts`)
- [x] T040 Full gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`, then walk [quickstart.md](quickstart.md) §2 table and §3 manual smoke end-to-end; confirm SC-001…SC-006 and re-verify the constitution check table in plan.md still holds

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: none
- **Phase 2 (Foundational)**: after T001 — BLOCKS all stories (T002→T003/T004/T005; T005+T006→T007; T008 independent; T009 last)
- **US1 (Phase 3)**: after Phase 2 — the resolver (T012) is the keystone every later story consumes
- **US2 (Phase 4)**: after US1 (consumes the typed error from T012/T013)
- **US3 (Phase 5)**: after US1 for the behavioral matrix (T023); the API/UI slice (T024–T027) only needs Phase 2's T008 and can start in parallel with US1/US2
- **US4 (Phase 6)**: after US1 (resolver + executor wiring); independent of US2/US3
- **US5 (Phase 7)**: after US1; the `parked:` event assertion needs US2
- **Phase 8 (Polish)**: after all desired stories

### Within stories

Tests written first and failing → implementation → story's integration spec green → full gate. `scope-ticket.spec.ts` and `test/integration/claude-cli-scoping.spec.ts` are shared files across stories — tasks touching them are sequential across phases (not [P] with each other), which the phase ordering already guarantees.

### Parallel Opportunities

- Phase 2: T003 ∥ T004 ∥ T005 (after T002); T008 ∥ everything
- After Phase 2: US3's contract/API/UI slice (T024→T025→T026→T027) in parallel with US1
- US1: T011 ∥ T010
- US2: T017 ∥ T016
- US3: T022 ∥ T023 ∥ T024
- US4: T029 ∥ T030 ∥ T031
- Polish: T038 ∥ T039

## Implementation Strategy

**MVP = Phase 1 + 2 + US1** (narrowing itself, fail-closed via plain failure): demonstrable value — scoped clones — with the flag as the safety. Then US2 (operator-friendly parking) and US3 (rollout control) complete the deployable core; US4/US5 are guard-rails + auditability. Single-developer order: phases as numbered. Two developers: after Phase 2, dev A takes US1→US2, dev B takes US3's API/UI slice then US4's wrapper work.

Stop-and-validate points: end of each phase (checkpoints above); the flag-OFF matrix (T023) is the regression firewall — run it after every executor-touching task.

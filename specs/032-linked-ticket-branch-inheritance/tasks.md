---

description: "Task list for feature 032 — linked-ticket branch inheritance + configurable dependency release status"
---

# Tasks: Linked-Ticket Branch Inheritance + Configurable Dependency Release Status

**Input**: Design documents from `/specs/032-linked-ticket-branch-inheritance/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/dependency-release.md, contracts/branch-inheritance.md, quickstart.md

**Tests**: MANDATORY — every phase here touches pipeline logic (gate decisions, ingest cache writes, executor lifecycle, human-task flows), so constitution Principle VI applies without exemption. Only the dashboard/presenter tasks carry the lighter UI-coverage rule.

**Organization**: grouped by user story; each story is an independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- Exact file paths are given for every task

## Path Conventions

Monorepo (pnpm workspaces): `packages/contracts/src/`, `libs/<lib>/src/`, `apps/backend/src/`, `apps/web/src/`, integration suites in `test/integration/`. Unit tests live beside their source as `*.spec.ts`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: establish the pre-change baseline so "byte-identical when unset" (FR-016) is verifiable, not asserted.

- [X] T001 Run `pnpm typecheck && pnpm lint && pnpm test` and record the green baseline (note any pre-existing failures in the PR description so they are not attributed to this feature)
- [X] T002 Run `pnpm test:integration` (Docker required) and confirm `test/integration/dependency-gate.spec.ts`, `test/integration/sprint-sequencing.spec.ts`, `test/integration/claude-cli-branch-handoff.spec.ts`, `test/integration/completion-gate.spec.ts` are green — these four are the FR-016 regression set

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the gate predicate and the settings field are consumed by every story below.

**⚠️ CRITICAL**: no user story work starts until this phase is complete

- [X] T003 Add optional `dependency_release_status: z.string().trim().min(1).optional()` to `WorkspaceSettingsSchema` in `packages/contracts/src/jira.types.ts`, with the same "ABSENT ⇒ byte-identical legacy behaviour, no DDL" comment style used by `rework_max`/`ticket_scoping`
- [X] T004 [P] Add `getDependencyReleaseStatus(db, workspaceId): Promise<string | undefined>` to `libs/database/src/workspace-settings.ts` (mirror `getReworkMax`; empty/whitespace ⇒ `undefined`)
- [X] T005 [P] Extend `libs/database/src/workspace-settings.spec.ts` with accessor cases: absent key, empty string, whitespace-only, valid value round-trip through `patchWorkspaceSettings`
- [X] T006 Extend the gate predicate in `libs/pipeline/src/dependency-gate.ts`: `blockingLinks`/`blockingKeys`/`evaluateDependencyGate` accept `opts?: { releaseStatus?: string }`; a link is satisfied when the blocker's category is `done` OR its `status.name` trim-and-case-insensitively equals `releaseStatus` (comparison skipped when the option is absent)
- [X] T007 Add `allBlockedByKeys(issue: JiraIssue): string[]` to `libs/pipeline/src/dependency-gate.ts` — ALL inward "is blocked by" keys regardless of blocker status; outward links still ignored; export it from `libs/pipeline/src/index.ts`
- [X] T008 Extend `libs/pipeline/src/dependency-gate.spec.ts` with the full decision table from `contracts/dependency-release.md` §1 (unset+done, unset+not-done, exact name match, case/whitespace variants, non-matching name, OR-done guard, unknown configured status ⇒ done-category behaviour) plus `allBlockedByKeys` cases (includes done blockers, ignores outward/`relates to` links, empty when no links)

**Checkpoint**: predicate and setting exist and are unit-proven; stories can proceed.

---

## Phase 3: User Story 1 — A dependent ticket starts as soon as its blocker is in review (Priority: P1) 🎯 MVP

**Goal**: an operator configures one workspace setting and dependents release at that blocker status instead of waiting for `done`.

**Independent Test**: configure the setting, move a blocker into that status (not done) → the dependent's run is dispatched; unset it → the same fixture waits for the done category.

### Tests for User Story 1 ⚠️

- [X] T009 [P] [US1] Extend `libs/pipeline/src/dependency-release.spec.ts`: release pass reads the setting once per pass and passes it to the gate; a name-satisfied blocker is not counted as an open blocker by `classifyWaiting`
- [X] T010 [P] [US1] Extend `libs/pipeline/src/pipeline.service.spec.ts`: the status-change path threads the same setting into `evaluateDependencyGate`/`blockingKeys`
- [X] T011 [US1] Extend `test/integration/dependency-gate.spec.ts` per `contracts/dependency-release.md` §7: (a) setting configured + blocker moved into it (not done) ⇒ dependent triggered by the release pass; (b) same fixture with setting unset ⇒ still waiting; (c) blocker jumps In Progress → Done without ever being observed in the configured status ⇒ dependent released; (d) two blockers, only one satisfied ⇒ still waiting; (e) case-insensitive match

### Implementation for User Story 1

- [X] T012 [US1] Thread the setting through `DependencyReleaseService` in `libs/pipeline/src/dependency-release.service.ts`: read `getDependencyReleaseStatus(this.db, ws.id)` once in `process()`, pass to `evaluateDependencyGate`/`blockingKeys` for every candidate and to `classifyWaiting` (classification keeps operating on OPEN blockers under the same threshold); leave candidates query, scope re-fetch, release order and fast path untouched
- [X] T013 [US1] Thread the setting through `PipelineService.onStatusChanged` in `libs/pipeline/src/pipeline.service.ts` (workspace id is already on the loaded ticket row); the blocked-branch log line keeps naming the still-open blockers
- [X] T014 [US1] Emit the early-release run event (`data-model.md` §5c) after a non-deduplicated `runTrigger.trigger` in `libs/pipeline/src/dependency-release.service.ts` and in the status-change path of `libs/pipeline/src/pipeline.service.ts`, only when ≥1 link was satisfied by name-match while the blocker's category was not `done`
- [X] T015 [US1] Add the per-pass unmatched-setting diagnostic in `libs/pipeline/src/dependency-release.service.ts`: when a status is configured, ≥1 candidate stayed waiting, and no blocker fetched in the pass carried that name ⇒ one `logger.warn` naming the workspace and the configured value (no per-ticket spam)
- [X] T016 [P] [US1] Expose `dependency_release_status` on the workspace settings payload and the settings PATCH route in `apps/backend/src/dashboard/workspaces.controller.ts` (next to `ticket_scoping`, ~L926): `null`/empty deletes the key from the blob, non-empty stores the trimmed string; no board-workflow validation (degrade, don't refuse)
- [X] T017 [P] [US1] Add the settings field plumbing in `apps/web/src/composables/useWorkspaces.ts` (same shape as the `ticket_scoping` mutation)
- [X] T018 [US1] Add the "Dependency release status" control to `apps/web/src/views/workspace-settings/GeneralPanel.vue`: single `el-select` with `allow-create` + `filterable`, options from `GET /api/workspaces/:id/statuses`, clearable; when the saved value is not among the observed statuses show a non-blocking warning ("status not observed on this board — the done-category rule still applies")
- [X] T019 [US1] Extend `test/integration/workspace-settings.spec.ts` (or the closest settings suite): PATCH stores/trims/clears the field and GET returns it; unknown status names are accepted

**Checkpoint**: early release works end to end and is operator-configurable; nothing about branch resolution has changed yet.

---

## Phase 4: User Story 2 — A dependent run starts from its blocker's unmerged branch (Priority: P1)

**Goal**: the dependent's worktree starts at the blocker's reported branch instead of the default branch, with the status-dependent missing-branch asymmetry.

**Independent Test**: complete a run on the blocker that reports a branch, release the dependent, verify its worktree HEAD for that repository is the blocker branch tip and the timeline records `inherited_from_blocker`.

### Tests for User Story 2 ⚠️

- [X] T020 [P] [US2] Extend `test/integration/sprint-sequencing.spec.ts` (the feature-022 blocked-cache suite; `libs/ingest` has no unit specs — the poller needs real Postgres + mock Jira) with the new write matrix: `blocked_by` is populated on EVERY observation (including tickets that are not waiting and tickets whose blockers are already done), `[]` when the issue has no inward links, retained after release, and `blocked_state` remains the only waiting signal
- [X] T021 [P] [US2] Extend `libs/executors/src/claude-cli/prior-work.spec.ts` for level-3 resolution: single blocker branch inherited; own prior work wins per repository; blocker with no succeeded run / no artifacts contributes nothing; blocker keys sorted deterministically; entries for unmounted repos collected separately
- [X] T022 [P] [US2] Extend `libs/executors/src/claude-cli/wrapper.spec.ts`: the `inherited_blocker` repository line, the `## Linked tickets` block (content, ordering, 10-entry cap, line truncation), and byte-identity of the rendered wrapper when no blocker data is present
- [X] T023 [P] [US2] Extend `libs/human-tasks/src/human-task.service.spec.ts` for the new title-keyed dedup method: same ticket + identical title ⇒ `{ created: false }`; different repo or blocker in the title ⇒ new task; a resolved task does not suppress a new one
- [X] T024 [US2] Add `test/integration/blocker-inheritance.spec.ts` (model on `test/integration/claude-cli-branch-handoff.spec.ts` + `mock-jira.ts`): blocker in the configured status with a pushed+reported branch ⇒ the dependent run's repo worktree HEAD equals that branch tip, a `start-ref` event with decision `inherited_from_blocker` names blocker and branch, and the wrapper carries the provenance line
- [X] T025 [US2] Extend `test/integration/blocker-inheritance.spec.ts` with the missing-branch matrix rows: blocker done + branch deleted ⇒ quiet default-branch start with decision `blocker_branch_merged` and NO human task; blocker not done + no usable branch ⇒ default-branch start, decision `blocker_no_artifact`, exactly one `[blocker_branch_lost]` task; a second run in the same condition adds the event but no second task

### Implementation for User Story 2

- [X] T026 [US2] Write `blocked_by` on every observation in `libs/ingest/src/poller.service.ts`: add `blockedBy: allBlockedByKeys(issue)` to the cache-advance update in `processIssues` (the same statement that writes `lastSeenStatus`), keeping the advance-after-trigger ordering
- [X] T027 [US2] Apply the rest of the write matrix (`data-model.md` §2): in `libs/pipeline/src/pipeline.service.ts` use `allBlockedByKeys` for the waiting write and make `clearWaitingState` null ONLY `blocked_state`; in `libs/pipeline/src/dependency-release.service.ts` write `blockedBy: allBlockedByKeys(issue)` on release (instead of `null`) and in `classifyWaiting`
- [X] T028 [US2] Audit `blocked_by` readers for the semantic change: `apps/backend/src/dashboard/workspaces.controller.ts` waiting endpoint already filters on `blocked_state is not null` (correct — confirm and comment); update the list label in `apps/web/src/views/WorkspaceWaiting.vue` so the keys read as observed links rather than "still open" blockers
- [X] T029 [US2] Implement `getBlockerWork(db, { workspaceId, blockedByKeys, currentTicketId })` in `libs/executors/src/claude-cli/prior-work.ts`: blocker ticket lookup by `(workspaceId, jiraKey)`, latest succeeded run with artifact entries (reuse the `SCAN_WINDOW = 5` loop), returning per-blocker `{ key, runId, entries }` plus `{ key, reason: 'no_ticket' | 'no_artifacts' }` for the matrix
- [X] T030 [US2] Implement per-repository layered resolution in `libs/executors/src/claude-cli/prior-work.ts` producing `RepoStartPlan` (`data-model.md` §3): levels 1–2 unchanged and repo-claiming; level 3 fills only unclaimed repos via `matchReportedBranches`; blockers sorted lexicographically; second-and-later blockers naming a claimed-by-blocker repo append to `mergeBranches` (consumed in US3); unmounted blocker artifacts collected separately
- [X] T031 [US2] Fetch blocker statuses at prepare in `libs/executors/src/claude-cli/claude-cli.executor.ts`: ONE `jira.searchUpdated('key in (…)', ['status'])` when the ticket has observed blockers, skipped entirely when `blocked_by` is empty/null; a fetch failure returns `crashed` with diagnostics naming the blocker keys (no silent fallback)
- [X] T032 [US2] Split the prepare loop in `libs/executors/src/claude-cli/worktree.ts` so caches are ensured (fetch `--prune`) before worktrees are added, and export a `branchExistsOnOrigin(cacheDir, branch)` probe (extract the existing private helper) — preserving the all-or-nothing unwind semantics
- [X] T033 [US2] Apply the missing-branch matrix in `libs/executors/src/claude-cli/claude-cli.executor.ts` between cache-ensure and worktree-add (`contracts/branch-inheritance.md` §4): own-work branches keep the feature-023 loud crash; blocker branch gone + blocker done ⇒ drop quietly; blocker not done with nothing usable ⇒ drop and flag for the human task
- [X] T034 [US2] Add `HumanTaskService.createTicketBlockedKeyed(workspaceId, ticketId, { title, details })` in `libs/human-tasks/src/human-task.service.ts` — dedup on open + run-less + same `ticket_id` + exact `title`; leave the existing coarse `createTicketBlocked` untouched
- [X] T035 [US2] Raise the `[blocker_branch_lost]` task from the executor (title and details per `data-model.md` §6) when the matrix hits the not-done-and-nothing-usable row
- [X] T036 [US2] Extend `recordStartRefEvent` in `libs/executors/src/claude-cli/claude-cli.executor.ts` with the new payload fields and the decisions `inherited_from_blocker`, `blocker_branch_merged`, `blocker_no_artifact` (`data-model.md` §5a), keeping one event per mounted repository including the boring cases
- [X] T037 [US2] Extend `WrapperRepoInfo` and `repositoriesSection` in `libs/executors/src/claude-cli/wrapper.ts` with the `inherited_blocker` provenance line (DEPENDENCY wording, PR-base fact) per `contracts/branch-inheritance.md` §6, keeping the existing default/continue-own lines byte-identical
- [X] T038 [US2] Add `linkedTicketsSection` to `libs/executors/src/claude-cli/wrapper.ts` (direct blockers, key order, cap 10, 200-char line cap) and feed it from the executor using the live statuses (T031) and blocker report entries (T029) — no extra fetches; render for both channels

**Checkpoint**: single-blocker inheritance works end to end, with the missing-branch asymmetry and its deduplicated human task.

---

## Phase 5: User Story 3 — Two blockers' branches for one repository are merged before the agent starts (Priority: P2)

**Goal**: diamond shapes start from a deterministic merge of the blockers' branches instead of an arbitrary parent or a crash.

**Independent Test**: two blockers report different branches of the same repository; the dependent's start commit is a merge commit containing both, and a conflicting pair fails the run loudly with one human task.

### Tests for User Story 3 ⚠️

- [X] T039 [P] [US3] Extend `libs/executors/src/claude-cli/worktree.spec.ts` (real git in tmp dirs): clean two-branch merge produces a merge commit and `startSha` resolved AFTER the merge; `--no-ff` yields a merge commit even when fast-forwardable; `mergedBranches` records merge order; a merge branch absent from origin is rejected; a conflicting merge throws `WorktreePrepareError` naming the repository and branches and unwinds every already-prepared worktree plus the parent dir
- [X] T040 [P] [US3] Extend `libs/executors/src/claude-cli/prior-work.spec.ts`: two blockers naming the same repository produce `startBranch` + ordered `mergeBranches`; three or more preserve deterministic order; blockers naming different repositories do not merge
- [X] T041 [US3] Extend `test/integration/blocker-inheritance.spec.ts`: diamond with a clean merge ⇒ dependent's start commit contains both blockers' work and the `start-ref` event decision is `merged_blockers` naming both branches and tickets; conflicting diamond ⇒ run fails and exactly one `[blocker_merge_conflict]` task exists
- [X] T042 [US3] Add a completion-gate interaction case (extend `test/integration/completion-gate.spec.ts` or the new suite): a run started at a merge commit that commits and reports normally passes the feature-024 gate unchanged

### Implementation for User Story 3

- [X] T043 [US3] Extend `prepareAll`/`addRepoWorktree` in `libs/executors/src/claude-cli/worktree.ts` with `mergeBranches?: Record<string, string[]>`: validate (`assertSafeBranchName`) and verify each branch on origin, then merge sequentially with `git -c user.name=brigadir -c user.email=brigadir@local merge --no-ff origin/<branch>` in the run's detached worktree; on conflict best-effort `git merge --abort` then throw `WorktreePrepareError` naming the repository, the start branch and the merge list
- [X] T044 [US3] Resolve `startSha` after the final merge and record `RepoStart.mergedBranches` in `libs/executors/src/claude-cli/worktree.ts` (`data-model.md` §4) so the completion-gate baseline includes the merged work by construction
- [X] T045 [US3] Pass the merge plan from `libs/executors/src/claude-cli/claude-cli.executor.ts` into `prepareAll`, and convert a merge-conflict `WorktreePrepareError` into the `[blocker_merge_conflict]` human task (title/details per `data-model.md` §6) before returning `crashed`
- [X] T046 [US3] Add the `merged_blockers` decision and `mergedBranches`/`blockers` payload fields to `recordStartRefEvent` in `libs/executors/src/claude-cli/claude-cli.executor.ts`
- [X] T047 [US3] Add the `merged_blockers` repository line to `repositoriesSection` in `libs/executors/src/claude-cli/wrapper.ts` ("already in your start point; open your PR against `<first branch>`, not `<default>`") and cover it in `libs/executors/src/claude-cli/wrapper.spec.ts`

**Checkpoint**: diamond chains prepare deterministically; conflicts fail loudly with an actionable task.

---

## Phase 6: User Story 4 — A cross-service dependent builds against its blocker's unmerged service (Priority: P2)

**Goal**: a frontend ticket blocked by a backend ticket mounts the backend repository at the blocker's branch; artifacts for repositories the run does not mount are diagnosed instead of silently ignored.

**Independent Test**: with an agent mounting both services, a backend blocker's branch appears in the dependent's `backend/` worktree while `frontend/` stays on its default branch; a blocker reporting an unmounted repository produces one event and one task.

### Tests for User Story 4 ⚠️

- [X] T048 [P] [US4] Extend `libs/executors/src/claude-cli/prior-work.spec.ts`: blocker entries naming repositories outside the run's mounted set are returned as unmounted (not silently dropped), while unmatched entries from the ticket's OWN prior work stay in the existing observability-only `unmatched` list
- [X] T049 [US4] Extend `test/integration/blocker-inheritance.spec.ts` with the cross-service case: two-repo agent, blocker reports only `backend` ⇒ `backend` at the blocker branch (`inherited_from_blocker`), `frontend` at its default branch, wrapper labels `backend` as DEPENDENCY; and the unmounted case ⇒ run proceeds, one `blocker_artifacts_unmounted` event, exactly one `[blocker_repo_unmounted]` task naming both fixes, deduplicated across two runs

### Implementation for User Story 4

- [X] T050 [US4] Emit the `blocker_artifacts_unmounted` event (repo-less shape, `data-model.md` §5b) from `libs/executors/src/claude-cli/claude-cli.executor.ts` for blocker artifacts naming repositories this run does not mount, keeping own-prior-work unmatched entries on today's observability-only path
- [X] T051 [US4] Raise the deduplicated `[blocker_repo_unmounted]` human task from `libs/executors/src/claude-cli/claude-cli.executor.ts`, with details naming the two fixes (add the Component to the dependent ticket, or widen the agent's repository scope)
- [X] T052 [US4] Verify (and comment at the call site in `libs/executors/src/claude-cli/claude-cli.executor.ts`) that repository mounting still comes solely from the agent base set narrowed by `narrowByTicketComponents` — inheritance never widens scope (FR-010)

**Checkpoint**: cross-service chains work by mounting, and a scope gap is a visible, actionable diagnostic rather than a silent default-branch start.

---

## Phase 7: User Story 5 — An operator can diagnose where a dependent started and why (Priority: P3)

**Goal**: every start decision and every early release is readable from the run timeline, and every human-attention case yields exactly one open task per dedup key.

**Independent Test**: exercise each decision path and confirm the timeline entry and the task count.

### Tests for User Story 5 ⚠️

- [X] T053 [P] [US5] Extend `apps/web/test/run-timeline-presenter.spec.ts` with view-model cases for the five new decisions and the early-release event — key/value bodies, tags, no raw JSON in the body
- [X] T054 [US5] Extend `test/integration/blocker-inheritance.spec.ts` with a completeness assertion: every mounted repository of every exercised run has exactly one `start-ref` event, and the boring cases (`default_branch`, `report_confirmed`) are still recorded

### Implementation for User Story 5

- [X] T055 [US5] Render the new start-ref decisions and the `dependency-release` early event in `apps/web/src/components/RunTimeline/presenter.ts` per the feature-026 rules (kv bodies, orchestrator/icon keys, no `JSON.stringify` in the body)
- [X] T056 [US5] Make the human-task details Markdown-scannable (headings/lists) in the three task builders so the queue viewer renders them usefully, consistent with existing system-composed tasks

**Checkpoint**: the whole feature is diagnosable from the dashboard without reading logs.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T057 [P] Update `docs/architecture.md`: §3 note that `tickets.blocked_by` is now an always-written observation (state semantics stay in `blocked_state`), and §4 the prepare pipeline's blocker resolution + merge step and the new start-ref decisions
- [X] T058 [P] Append the iteration entry to `docs/progress.md` (what shipped, the two justified deviations from plan.md Complexity Tracking, and the no-migration property)
- [X] T059 [P] Document the new workspace setting in `docs/spec.md` / `docs/plan-internal.md` where the other workspace settings are listed
- [X] T060 Re-run the FR-016 regression set from T002 with the setting unset and no blockers observed, and confirm zero behavioural diff (gate decisions, start refs, timeline events, wrapper text)
- [X] T061 Run the full gates: `pnpm typecheck && pnpm lint && pnpm test` then `pnpm test:integration`
- [ ] T062 Walk `specs/032-linked-ticket-branch-inheritance/quickstart.md` §3 manually against the dev stack (early release, inheritance, diamond, lost branch, dedup) and tick its Definition of Done checklist

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: after Setup — BLOCKS every story (T006/T007 are consumed by US1 and US2 alike)
- **US1 (Phase 3)**: after Phase 2 — fully independent of US2–US5
- **US2 (Phase 4)**: after Phase 2 — independent of US1 (inheritance works for done-category releases too); US1 makes it observable earlier
- **US3 (Phase 5)**: after US2 (extends the resolution plan and the worktree layer US2 introduces)
- **US4 (Phase 6)**: after US2 (reuses blocker resolution and the event/task plumbing); independent of US3
- **US5 (Phase 7)**: after the stories whose decisions it renders (US2 minimum; complete after US3/US4)
- **Polish (Phase 8)**: after all desired stories

### Within Each User Story

- Tests first (they must fail before the implementation task lands — constitution VI)
- Resolution/plan layer (`prior-work.ts`) before the git layer (`worktree.ts`) before the executor wiring
- Executor wiring before wrapper/event rendering
- Backend before web for the settings surface

### Parallel Opportunities

- T004 + T005 (accessor and its spec are separate files from T003's schema edit — land T003 first)
- All `[P]`-marked test tasks within a story: T009+T010, T020–T023, T039+T040, T048, T053
- T016 + T017 (backend controller vs web composable) in US1
- Docs tasks T057–T059 run fully in parallel
- With multiple developers: after Phase 2, US1 and US2 proceed in parallel; once US2 lands, US3 and US4 proceed in parallel

---

## Parallel Example: User Story 2

```bash
# Tests first, all independent files:
Task: "Poller blocked_by write coverage in libs/ingest/src/poller.service.spec.ts"
Task: "Level-3 precedence coverage in libs/executors/src/claude-cli/prior-work.spec.ts"
Task: "Wrapper provenance + Linked tickets coverage in libs/executors/src/claude-cli/wrapper.spec.ts"
Task: "Title-keyed dedup coverage in libs/human-tasks/src/human-task.service.spec.ts"

# Then implementation, respecting the resolution → git → executor order:
Task: "getBlockerWork in libs/executors/src/claude-cli/prior-work.ts"
Task: "Cache-ensure split + branchExistsOnOrigin in libs/executors/src/claude-cli/worktree.ts"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational → Phase 3 US1
2. **STOP and VALIDATE**: chains release at the configured status; unset behaves exactly as before
3. Shippable on its own — teams get the days-earlier start immediately, still starting from the default branch

### Incremental Delivery

1. Foundation → US1 (early release) → demo
2. US2 (single-blocker inheritance + missing-branch asymmetry) → demo; this is where the feature's premise is realized
3. US3 (diamond merges) → demo
4. US4 (cross-service mounting diagnostics) → demo
5. US5 (timeline/task polish) → demo
6. Phase 8 docs + full-gate run

### Notes

- `[P]` = different files, no dependency on an incomplete task
- No database migration exists in this feature by design — any task that appears to need DDL is a signal to revisit `data-model.md`, not to add a migration
- FR-016 (byte-identical when unset) is a standing constraint on every task, verified explicitly in T060

# Tasks: Branch Handoff Follow-Up

**Input**: Design documents from `/specs/024-branch-handoff-followup/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D7), data-model.md, contracts/

**Tests**: MANDATORY — all three stories are pipeline logic (constitution Principle VI). Test tasks precede implementation within each story; write them first and see them fail.

**Organization**: One phase per user story, in spec priority order (US1 → US2 → US3). Stories are independent; US3 is the largest and rides last.

**Session constraint**: Docker is unavailable in the authoring session — integration-test tasks are WRITTEN here but their execution is deferred to the operator's stand (iteration-29 precedent; must be stated in the progress entry, never implied).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 per spec.md

## Phase 1: Setup

**Purpose**: Confirm a clean baseline so every later failure is attributable to this feature.

- [X] T001 Run `pnpm typecheck && pnpm lint && pnpm test` on the unmodified branch and record the baseline result (all green expected; any pre-existing failure gets noted in specs/024-branch-handoff-followup/tasks.md next to this task before proceeding)

---

## Phase 2: Foundational

No foundational tasks — the three stories share no new infrastructure (no migrations, no new modules used by more than one story). Each story is self-contained per plan.md.

**Checkpoint**: after T001, all three story phases may start (US1 ∥ US2 ∥ US3 if parallelized).

---

## Phase 3: User Story 1 — Rework agent is told which branch carries the prior work (Priority: P1) 🎯 MVP

**Goal**: `failureLines` and `buildReworkSection` in `libs/pipeline/src/handoff.ts` render artifact lines via `normalizeReportArtifacts` — one line per reported repo (contract `contracts/handoff-artifact-lines.md`); v1 rendering byte-identical.

**Independent Test**: `pnpm vitest run libs/pipeline/src/handoff.spec.ts` — new v2 cases pass, every pre-existing v1 assertion passes unmodified.

### Tests for User Story 1 (write first, must fail) ⚠️

- [X] T002 [US1] Extend `libs/pipeline/src/handoff.spec.ts` with failing cases per the contract: (a) rework section with `artifacts.repos: [{repo, branch, pr_url}, {repo, branch}]` renders a `Continue on:` block with one `- <repo>: …` line each; (b) triage and answer-triage sections render the same shape under `Artifacts:`; (c) report with BOTH flat fields and `repos[]` renders only `repos[]` (no double-render); (d) `repos: []` and absent artifacts render no block; (e) v2 entry with only `pr_url` renders the PR part alone. Do NOT touch existing v1 assertions.

### Implementation for User Story 1

- [X] T003 [US1] In `libs/pipeline/src/handoff.ts`, replace the flat-field reads in `failureLines` (~112–118) and `buildReworkSection` (~263–269) with a shared local renderer over `normalizeReportArtifacts(report)` (import from `@brigadir/contracts`): single normalized entry with `repo === undefined` ⇒ today's single-line form byte-for-byte; entries with `repo` ⇒ header line (`Artifacts:` / `Continue on:`) + one `- <repo>: branch <b>, PR <p>` line per entry, omitting absent parts, skipping entries with neither. Preserve the try/catch best-effort contract and all truncation budgets.
- [X] T004 [US1] Run `pnpm vitest run libs/pipeline/src/handoff.spec.ts` until green, then `pnpm typecheck && pnpm lint`.

**Checkpoint**: US1 shippable alone — the live bug is fixed.

---

## Phase 4: User Story 2 — First stage names its own branch, no system suggestion (Priority: P2)

**Goal**: No system-proposed branch name anywhere in the wrapper (contract `contracts/wrapper-branch-lines.md`); `branch_prefix` stays inert everywhere it is stored (FR-007); suggestion machinery deleted (research D2).

**Independent Test**: `pnpm vitest run libs/executors/src/claude-cli/wrapper.spec.ts libs/executors/src/claude-cli/worktree.spec.ts libs/executors/src/claude-cli/claude-cli.executor.spec.ts` — no-prior-branch lines carry no `— create …` tail; continuation lines byte-identical to 023.

### Tests for User Story 2 (write first, must fail) ⚠️

- [X] T005 [P] [US2] Update `libs/executors/src/claude-cli/wrapper.spec.ts`: no-prior-branch repo line asserts exactly `- <name>: <path> (no prior branch; at <default>)`; assert the wrapper text contains no `create ` branch suggestion for any repo; continuation-line assertions unchanged; update the rules-line assertion to the reworded "create a branch of your own choosing … and report it" semantics (exact wording fixed here). Refresh `libs/executors/src/claude-cli/__snapshots__` only via `vitest -u` AFTER assertions are precise.
- [X] T006 [P] [US2] In `libs/executors/src/claude-cli/worktree.spec.ts` and `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`, remove/replace tests of `setupRunBranchIdentity` and of `suggestedBranch`/`branchPrefix` plumbing with assertions that (a) ticket runs and setup runs build wrappers without any suggested name, (b) `behavior.branch_prefix` present in config is accepted and ignored (no throw, no wrapper effect).

### Implementation for User Story 2

- [X] T007 [US2] In `libs/executors/src/claude-cli/wrapper.ts`: delete `WrapperRepoInfo.suggestedBranch` and the `— create …` tail in `repositoriesSection`; reword the branching rule line per the contract (continue the listed branch; otherwise create your own with `git switch -C <your-branch>`, push, and report it); extend the reporting rule sentence with the US3 warning ("a completion that omits a repository with local commits will be rejected").
- [X] T008 [US2] In `libs/executors/src/claude-cli/worktree.ts`: delete `setupRunBranchIdentity` (and its export). In `libs/executors/src/claude-cli/claude-cli.executor.ts`: delete the `suggestedBranch` local + both assignments (ticket and setup paths, ~198–226), the `suggestedBranch` field in the wrapper-repos mapping (~297), and the `branchPrefix: behavior.branch_prefix ?? 'run'` return (~736–738) with its now-unused destructuring; keep `behavior.branch_prefix` in the type only if still referenced, otherwise drop the key from the local `behavior` type annotation (~607).
- [X] T009 [US2] Sweep remaining references: `pnpm exec grep -rn "suggestedBranch\|setupRunBranchIdentity" libs/ apps/ packages/ test/` must return nothing; update `test/integration/wrapper-feature-context.spec.ts` and `test/integration/claude-cli-lifecycle.spec.ts` assertions that expect a `create feat/<KEY>` wrapper line (the `behavior: { branch_prefix: 'feat' }` fixtures STAY — they now prove inertness per FR-007/SC-004). Integration execution deferred to the stand (no Docker here) — compile-correctness via `pnpm typecheck`.
- [X] T010 [US2] Run `pnpm vitest run libs/executors/src/claude-cli` until green, then `pnpm typecheck && pnpm lint`.

**Checkpoint**: US1 + US2 shippable; wrapper contract settled before US3 touches the same files' vicinity.

---

## Phase 5: User Story 3 — Unreported work cannot complete as-is (Priority: P3)

**Goal**: `complete_task` gated per `contracts/completion-gate.md`: executor records `startSha` (start-ref event moves after `prepareAll`) and passes `BRIGADIR_REPO_DIRS` to the tool server; mcp-server observes HEADs into `x-brigadir-observed-heads`; backend rejects completions omitting a moved repo (run stays active, `handoff-violation` run_event), evidence-absent cases silent (research D3–D6, data-model.md).

**Independent Test**: `pnpm vitest run packages/mcp-server/src/tools.spec.ts libs/callback libs/executors/src/claude-cli/worktree.spec.ts libs/executors/src/claude-cli/claude-cli.executor.spec.ts libs/executors/src/claude-cli/mcp-config.spec.ts` — reject → correct → accept flow proven at unit level.

### Tests for User Story 3 (write first, must fail) ⚠️

- [ ] T011 [P] [US3] `libs/executors/src/claude-cli/worktree.spec.ts`: `prepareAll` returns `RepoStart.startSha` = 40-hex commit of the detached worktree, for both default-branch and continue-branch starts.
- [ ] T012 [P] [US3] `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`: start-ref run_events are written AFTER successful `prepareAll` with `startSha` in each payload; a prepare failure writes no start-ref rows; existing payload keys (`decision`, `continueBranch`, `reportedByRunId`, `unmatchedReportedRepos`) unchanged.
- [ ] T013 [P] [US3] `libs/executors/src/claude-cli/mcp-config.spec.ts`: the tool-server env block gains `BRIGADIR_REPO_DIRS` as a JSON map `{repoName: absWorktreeDir}` for repo runs; absent for no-repo runs; file mode/location/cleanup semantics unchanged (Constitution V).
- [ ] T014 [P] [US3] `packages/mcp-server/src/tools.spec.ts`: `complete_task` attaches `x-brigadir-observed-heads` built from injected git results (fetchImpl capture asserts the header JSON); a repo whose rev-parse fails is omitted; no `BRIGADIR_REPO_DIRS` (or malformed JSON) ⇒ no header; header attached regardless of outcome; marker still written only on 2xx.
- [ ] T015 [P] [US3] New `libs/callback/src/completion-gate.spec.ts`: pure decision-function table tests per data-model.md §5 — moved+unreported ⇒ violation; moved+reported ⇒ none; unmoved ⇒ none; evidence absent (null observed / repo missing from observed / missing startSha) ⇒ none; v1 flat report attributes only when exactly one repo mounted; exact-inequality (amend counts as moved).
- [ ] T016 [US3] `libs/callback/src/callback.service.spec.ts`: service-level — violating completion returns the validation-failure envelope listing repo + both SHAs, run stays active (`finalizeWithReport` NOT called), one `handoff-violation` run_event written; corrected report then accepted and finalizes; header absent ⇒ accepted; `team` outcome with no start-ref rows unaffected; 409 for already-finalized runs unchanged.

### Implementation for User Story 3

- [ ] T017 [US3] `libs/executors/src/claude-cli/worktree.ts`: extend `RepoStart` with `startSha: string`; resolve it in `addRepoWorktree` via `git rev-parse HEAD` in the fresh worktree (through the existing `git()` helper; failure ⇒ `WorktreePrepareError`, all-or-nothing unwind as today).
- [ ] T018 [US3] `libs/executors/src/claude-cli/claude-cli.executor.ts`: move the `recordStartRefEvent` call to after `prepareAll` succeeds; change its signature to take the prepared `MultiPrepareResult` (source of `startSha` per repo) alongside `prior`/`matched`; add `startSha` to each event payload (data-model.md §1); update the doc comment about the event doubling as the mount record.
- [ ] T019 [US3] `libs/executors/src/claude-cli/mcp-config.ts` (+ its call site in the executor): add `BRIGADIR_REPO_DIRS` to the tool-server env block for repo runs — JSON of `{r.repo.name: r.worktreeDir}` from the prepared workspace; omit for no-repo runs.
- [ ] T020 [US3] `packages/mcp-server/src/main.ts` + `packages/mcp-server/src/tools.ts`: read optional `BRIGADIR_REPO_DIRS` (lenient parse, stderr log on malformed ⇒ treat absent); in the `complete_task` handler, before POST, `git rev-parse HEAD` (execFile, injectable for tests) per configured repo dir, omit failures, and attach `x-brigadir-observed-heads` to that request only. No decision logic in the tool server.
- [ ] T021 [US3] New `libs/callback/src/completion-gate.ts`: zod parser for the header (record of repo→40-hex, ≤20 entries; invalid ⇒ null) + pure `detectHandoffViolations(startRefs, observed, normalizedArtifacts, mountedCount)` per data-model.md §5; export via `libs/callback/src/index.ts` if needed by specs.
- [ ] T022 [US3] `libs/callback/src/callback.controller.ts` + `libs/callback/src/callback.service.ts`: pass the raw header into `complete`; before the team-branch and `finalizeWithReport`, load this run's `start-ref` run_events (repo→startSha), run the gate, and on violations: write ONE `handoff-violation` run_event (data-model.md §2) and return the validation-failure envelope with per-repo diagnostics + corrective instruction (push branch, add `artifacts.repos` entry, complete again). No change to accepted-path ordering.
- [ ] T023 [US3] Run `pnpm vitest run packages/mcp-server libs/callback libs/executors/src/claude-cli` until green, then `pnpm typecheck && pnpm lint && pnpm test` (full unit gate).

### Integration test (written now, EXECUTION DEFERRED — needs Docker)

- [ ] T024 [US3] Extend `test/integration/callback-completion.spec.ts` (or add `test/integration/completion-gate.spec.ts` following the harness pattern in `test/integration/harness.ts`): full flow — run prepared with recorded `startSha` → advance HEAD in one repo worktree → `POST /complete` without that repo ⇒ rejection envelope, run still `running`, `handoff-violation` event present → corrected `POST /complete` ⇒ run finalizes, ticket flow proceeds. Mark clearly in the spec file header that it was authored without a local Docker run; do NOT weaken existing suites.

**Checkpoint**: all three stories functionally complete at unit level.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T025 [P] Update `docs/architecture.md` §5 (callback protocol): `x-brigadir-observed-heads` header + completion gate + rejection semantics; §start-ref note about `startSha` and the post-prepare write; note that the wrapper no longer proposes branch names.
- [ ] T026 [P] Update `docs/spec.md`: `branch_prefix` comment (~24, ~52) — field is stored but inert since 024 (suggestion removed); adjust the agent-config example comment in `agents.example.yaml` (~44, ~57) the same way.
- [ ] T027 Append the iteration entry to `docs/progress.md`: what shipped (three stories), the D3 ordering discovery (exit-time sketch abandoned, gate at complete_task, operator-confirmed), explicit statement that `pnpm test:integration` was NOT run in the authoring session (no Docker) and which suites the stand must run, plus the pre-existing 6 integration failures remaining out of scope.
- [ ] T028 Final gate: `pnpm typecheck && pnpm lint && pnpm test` green on the full tree; re-run the quickstart.md unit commands verbatim; verify `git status` clean after commit.

---

## Dependencies & Execution Order

- **T001** → everything.
- **US1 (T002–T004)**: independent; MVP — shippable alone.
- **US2 (T005–T010)**: independent of US1. T005/T006 [P] → T007/T008 → T009 → T010.
- **US3 (T011–T024)**: independent of US1; touches `wrapper.ts` only via US2's T007 sentence — do T007 before T023 if running stories in parallel. Within US3: T011–T016 [P] (tests, different files) → T017 → T018 → T019 (executor chain, same-file order) ∥ T020 ∥ T021 → T022 → T023 → T024.
- **Polish (T025–T028)**: after all stories; T025/T026 [P].

### Parallel opportunities

- After T001: US1, US2, US3 test-writing can all start (T002 ∥ T005 ∥ T006 ∥ T011–T016 — all different files).
- US3 implementation forks: executor chain (T017→T018→T019), mcp-server (T020), gate module (T021) are three independent tracks converging at T022.

## Implementation Strategy

MVP = US1 alone (fixes the live bug; smallest diff). Then US2 (small, settles the wrapper contract), then US3 (largest, gated by the most tests). Commit per story checkpoint; each checkpoint leaves the tree green (`pnpm typecheck && pnpm lint && pnpm test`). Integration suite runs on the operator's stand after deploy — rebuild `dist/` AND restart worker+backend before observing behavior.

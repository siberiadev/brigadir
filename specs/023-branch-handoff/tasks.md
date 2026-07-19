# Tasks — Branch Handoff Between Pipeline Stages (023)

All tasks complete. `[P]` = parallelizable with its siblings.

## Phase 1 — the git layer

- [X] **T001** `libs/executors/src/claude-cli/worktree.ts`: add `RepoStart`, put `start` on `RepoWorktree`, delete `MultiPrepareResult.branch`, new `prepareAll(repos, runId, worktreeRoot, repoCacheRoot, { continueBranches })`.
- [X] **T002** Same file: replace `addRepoWorktree` with `git worktree add --detach <dir> <startRef>`; delete `branchExists`, the zero-commit reclaim, the with-commits guard and `reuseBranch`. Add `remoteBranchExists` (checks `refs/remotes/origin/*`) and `assertSafeBranchName` (rejects leading `-`, then `git check-ref-format --branch`).
- [X] **T003** Same file: `git fetch --prune origin` in `ensureCache`, with a comment stating it is load-bearing (D3) and must not be dropped.
- [X] **T004** Same file: rewrite the doc comments at the old `:134-149` and `:184-192` — they described exactly the policy being removed — and re-frame `setupRunBranchIdentity` as a suggested name.
- [X] **T005** `worktree.spec.ts`: drop `ticketKey`/`'feat'` from the `prep` shim. Delete the six leftover-guard / `reuseBranch` tests. Rewrite the branch-creation and "same branch across repos" assertions for detached HEAD.
- [X] **T006** `worktree.spec.ts` new cases: continue a pushed branch; missing branch → loud failure + unwind; stale remote-tracking ref after upstream deletion (pins T003); per-repo divergence; malformed branch names.

## Phase 2 — prior work [P with Phase 1]

- [X] **T007** `libs/executors/src/claude-cli/prior-work.ts`: `getPriorWork` — `preferRunId` (no status filter) → latest `succeeded` on the ticket (`limit(5)` window, self excluded) → undefined; branch entries only, via `normalizeReportArtifacts`.
- [X] **T008** Same file: `matchReportedBranches` — exact then one case-insensitive match; flat v1 form only when exactly one repo is mounted; unmatched names recorded not fatal; first duplicate wins.
- [X] **T009** `prior-work.spec.ts`: nine cases covering T008's rules (pure — no DB, no git).

## Phase 3 — wrapper [P with Phases 1–2]

- [X] **T010** `wrapper.ts`: `WrapperRepoInfo.branch` → `continueBranch?` + `suggestedBranch?`; rewrite the `## Repositories` section for detached HEAD, the two per-repo line forms, `git switch -C` before the first commit, "never start a competing branch", and "the next stage starts from the branch you report here".
- [X] **T011** `wrapper.spec.ts`: update the repo-line assertions; add continue-branch and branch-before-commit cases.

## Phase 4 — wiring

- [X] **T012** `claude-cli.executor.ts`: select `ticketId` in `loadRunConfig` and return it plus `preferRunId` from `trigger_event.failing_run_id`.
- [X] **T013** Same file: replace the branch-identity block with suggested-name resolution + `getPriorWork`/`matchReportedBranches` (ticketed runs only, NOT best-effort), and the new `prepareAll` call.
- [X] **T014** Same file: `recordStartRefEvent` beside `recordScopingEvent` — one entry per mounted repo, written unconditionally including `decision: 'default_branch'`.
- [X] **T015** Same file: map `continueBranch` + `suggestedBranch` into `buildWrapperText`.
- [X] **T016** Delete `isResumedAttempt`: `agent-executor.interface.ts` (declaration, replaced by a do-not-reintroduce note), `claude-cli-run.processor.ts` (the `buildContext` line and the private method).
- [X] **T017** `claude-cli.executor.spec.ts`: `fakeWorkspace` gains `start`; the db mock gains `ticketId` and the prior-work `orderBy` shape; the setup-run test asserts the suggested name in the wrapper instead of the old positional `prepareAll` args.

## Phase 5 — integration

- [X] **T018** `claude-cli-repository.spec.ts` and `claude-cli-scoping.spec.ts`: replace `branchInCache(repo, ticketKey)` with `mountedInRun(runId, repo)` reading the `start-ref` entries. Two call sites needed the successor / `res.runId` rather than the parked run's id.
- [X] **T019** `claude-cli-branch-handoff.spec.ts` (new): the ST3-780 regression — prior stage pushes and reports, next stage dispatched with source `poll`, asserting HEAD is the prior commit, the wrapper says `continue branch`, and the timeline records `report_confirmed`. Plus the no-prior-work case and the missing-branch loud failure.
- [X] **T020** Confirm the new suite fails on the pre-change tree (it does — all three, including the silent false success).

## Phase 6 — documents

- [X] **T021** `specs/023-branch-handoff/` — spec, research, plan, tasks.
- [X] **T022** `docs/architecture.md` §4/§6/§7/§8 and `docs/spec.md` — the run branch, `RunContext`, the artifacts contract, the wrapper section.
- [X] **T023** Superseded markers in `specs/019-multi-repo-runs/` (spec, data-model, research D3/D4, plan, tasks T004).
- [X] **T024** `docs/progress.md` iteration entry.

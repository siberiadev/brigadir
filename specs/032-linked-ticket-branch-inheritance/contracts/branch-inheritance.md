# Contract: Branch Inheritance from Blockers

**Feature**: 032 | Covers spec FR-005…FR-014, FR-016 (inheritance half)

## 1. Observation write (`libs/ingest/src/poller.service.ts` + pipeline paths)

The poller's per-issue cache advance additionally writes
`blockedBy: allBlockedByKeys(issue)` on EVERY observation (empty array when the issue has no
inward blocked-by links). Full write matrix: data-model.md §2. Invariant: after any observation
of ticket T, `tickets.blocked_by` equals the inward blocked-by key set of that observation;
`blocked_state` alone signals waiting.

## 2. Resolution precedence (`libs/executors/src/claude-cli/prior-work.ts`)

Per mounted repository, first source that names a branch wins; NO merging across levels:

| Level | Source | Repo claim |
| --- | --- | --- |
| 1 | `preferRunId` report (rework / human-resume / triage) | as today |
| 2 | latest succeeded run on THIS ticket (window 5) | as today |
| 3 | blockers: for each key in `tickets.blocked_by` (sorted lexicographically), the blocker ticket's latest succeeded run with artifact entries (window 5), `matchReportedBranches` onto still-unclaimed repos | first blocker naming a repo sets `startBranch`; later blockers naming the SAME repo append to `mergeBranches` |
| 4 | none | default branch |

Matching rules are the existing ones verbatim: exact repo name, then one case-insensitive
fallback; flat v1 reports attributable only in single-repo runs; first entry per repo wins;
nothing fuzzy.

New reader: `getBlockerWork(db, { workspaceId, blockedByKeys, currentTicketId })` — blocker
lookup by `(workspaceId, jiraKey)`; keys not found as tickets (never observed / other project)
contribute nothing and are reported as `{ key, reason: 'no_ticket' }` for the missing-branch
matrix.

## 3. Blocker status fetch (executor, prepare phase)

When the plan contains ≥1 blocker-sourced repo OR ≥1 blocker key with no usable artifacts:
ONE `jira.searchUpdated('key in (<keys>)', ['status'])`. Failure ⇒ run crashes with diagnostics
naming the blocker keys (no silent fallback). Runs with `blocked_by` empty/null perform NO fetch
and are byte-identical to feature-023 behaviour (FR-016).

## 4. Missing-branch matrix (executor, between cache ensure and worktree add)

For each mounted repo / blocker entry, after `ensureCache` (fetch `--prune` already done):

| Case | Behaviour | Event decision | Human task |
| --- | --- | --- | --- |
| Own reported branch (level 1/2) absent from origin | `WorktreePrepareError` — run fails | (prepare fails; no start-ref rows, unchanged 023) | none (loud crash is the signal) |
| Blocker branch absent, blocker category `done` | drop entry; repo falls to next source or default | `blocker_branch_merged` | none (quiet) |
| Blocker not done AND (no artifact entries, or branch absent, or key has no ticket row) | repo falls through; run proceeds | `blocker_no_artifact` | `[blocker_branch_lost]` (dedup: open + same ticket + exact title) |
| Blocker reported repo the run does NOT mount | run proceeds | `blocker_artifacts_unmounted` (repo-less worktree event) | `[blocker_repo_unmounted]` naming the two fixes |
| Unmatched entries from OWN prior work | run proceeds | listed in `unmatchedReportedRepos` (unchanged) | none (feature-020 escape hatch) |

"Blocker not done" uses the live fetch of §3, evaluated at prepare time.

## 5. Merge contract (`libs/executors/src/claude-cli/worktree.ts`)

`prepareAll(repos, runId, roots, { continueBranches, mergeBranches })`:

- `mergeBranches[repoName]` non-empty ⇒ after detached checkout at
  `origin/<startBranch>`, sequentially `git -c user.name=brigadir -c user.email=brigadir@local
  merge --no-ff origin/<branch>` in the run's worktree, in the given (deterministic) order.
- Every merged branch passes `assertSafeBranchName` + origin-existence check first.
- Conflict ⇒ best-effort `git merge --abort`, then `WorktreePrepareError`:
  `repo "<name>": blocker branches conflict — "<start>" + merge of ["<b2>", …] (from <keys>)`;
  all-or-nothing unwind of already-prepared repos (existing semantics). Executor converts this
  specific error into the `[blocker_merge_conflict]` human task before returning `crashed`.
- `startSha` = `rev-parse HEAD` AFTER the final merge ⇒ feature-024 completion gate unchanged.
- `RepoStart.mergedBranches` records merge order for events/wrapper.
- No branch is created, deleted or pushed by the system (feature-023 invariant holds; the merge
  commit exists only in the detached worktree until the agent pushes its own branch).

## 6. Wrapper contract (`libs/executors/src/claude-cli/wrapper.ts`)

Repositories section line variants (facts, not instructions — D7):

```
- <name>: <path> (no prior branch; at <default>)                                  # default
- <name>: <path> (continue branch <b>, based on <default>)                        # continue_own (unchanged)
- <name>: <path> (DEPENDENCY — branch <b> from <KEY>, not yet in <default>;
                  read it and build against it, do not modify unless the task says so)   # inherited_blocker
- <name>: <path> (continues <b1> from <KEY1> merged with <b2> from <KEY2> — already in your
                  start point; open your PR against <b1>, not <default>)           # merged_blockers
```

`## Linked tickets` block (new section, rendered only when ≥1 entry): one line per direct
blocker, nearest first (direct blockers only, sorted by key), cap 10 entries, 200-char line cap:

```
- <KEY> [<status>] branch: <branch> PR: <pr_url>
```

Both sections render for callback AND structured-output channels (they are workspace facts, not
channel protocol). Runs with no blocker data render byte-identical to today (FR-016).

## 7. Timeline events

Payload schemas: data-model.md §5. Every mounted repo emits exactly one PER-REPO start-ref event
per run (boring cases included). The drop decisions (`blocker_branch_merged`,
`blocker_no_artifact`, `blocker_artifacts_unmounted`) are ADDITIONAL rows, written during the
matrix pass before any worktree exists — as implemented, a repo that fell back to the default
branch because its blocker's branch vanished carries both its `default_branch` per-repo event and
the drop event naming the blocker. That is deliberate: the per-repo event answers "where did this
repo start?", the drop event answers "what did it lose, and whose?", and collapsing them would
drop the blocker key from one of the two answers. Presenter
(`RunTimeline/presenter.ts`) renders the new decisions as kv-bodies with tags; no JSON dumps
(feature-026 rules).

## 8. Test contract (minimum)

Unit:
- `prior-work.spec`: level-3 resolution — single blocker; own-work-wins per repo; two blockers
  same repo → start + merge list ordered by key; blocker with no succeeded run; unmatched repo
  collection; determinism.
- `worktree.spec` (real git, tmp dirs): clean 2-branch merge → merge commit, `startSha` after
  merge, `mergedBranches` recorded; conflicting merge → `WorktreePrepareError` naming repo and
  branches + full unwind; merge branch absent from origin rejected; `--no-ff` (merge commit even
  when fast-forwardable).
- `wrapper.spec`: all four line variants; Linked tickets block content, cap and byte-identity
  when absent.
- `dependency-gate.spec`: `allBlockedByKeys` (see dependency-release.md).
- Human-task dedup: same title ⇒ `{created:false}`; different repo/blocker ⇒ new task.

Integration (Docker):
- NEW `blocker-inheritance.spec.ts` (model: `claude-cli-branch-handoff.spec.ts` + mock-jira):
  blocker in configured status with pushed+reported branch → dependent run's repo worktree HEAD
  = blocker branch tip; start-ref event `inherited_from_blocker`; wrapper facts present.
- Diamond: two blockers, clean merge → start commit contains both; conflict → run failed +
  `[blocker_merge_conflict]` task.
- Missing-branch matrix rows (done-quiet vs not-done-task) + dedup across two runs.
- Regression: `claude-cli-branch-handoff.spec.ts`, `dependency-gate.spec.ts`,
  `sprint-sequencing.spec.ts` unchanged with the setting unset and no blockers.

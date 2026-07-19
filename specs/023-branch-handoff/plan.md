# Implementation Plan — Branch Handoff Between Pipeline Stages (023)

## Shape

Three files change substantively, one is new, three lines are deleted. No schema change, no `schema_version` bump, no config or UI surface removed, no migration.

```
worktree.ts        system stops creating branches; detached at a resolved start ref
prior-work.ts      NEW — which branch did the previous stage report, for which repo
claude-cli.executor.ts   resolve → prepare → record; branch_prefix becomes a suggestion
wrapper.ts         tells the agent it is detached, what to continue/create, why reporting matters
agent-executor.interface.ts + claude-cli-run.processor.ts   isResumedAttempt deleted
```

## Contracts

```ts
// worktree.ts
export interface RepoStart { startRef: string; continueBranch?: string }
export interface RepoWorktree { repo; worktreeDir; cacheDir; start: RepoStart }
export interface MultiPrepareResult { parentDir; repos: RepoWorktree[] }   // `branch` REMOVED

export function prepareAll(
  repos: WorktreeRepo[], runId: string, worktreeRoot: string, repoCacheRoot: string,
  opts?: { continueBranches?: Record<string, string> },
): Promise<MultiPrepareResult>;

// prior-work.ts
export function getPriorWork(db, { ticketId, currentRunId, preferRunId? }): Promise<PriorWork | undefined>;
export function matchReportedBranches(entries, repos): { continueBranches; unmatched };

// wrapper.ts
export interface WrapperRepoInfo { name; absPath; defaultBranch; continueBranch?; suggestedBranch? }
```

`MultiPrepareResult.branch` is deleted rather than repurposed: repo A may continue `run/T` while repo B starts from `main`, so one shared name is now a structural lie. Per-repo provenance lives in `RepoWorktree.start`.

`RunContext.isResumedAttempt` is deleted, not left as a no-op. It is optional, so removal is source-compatible and needs no version bump — and keeping it would be a loaded gun for the next person, who would wire behavior to it and thereby reintroduce trigger-source inference, the exact reasoning that caused ST3-780.

## Execution order

1. `worktree.ts` — `--prune` on the cache fetch; `remoteBranchExists` + `assertSafeBranchName`; `addRepoWorktree` → detached, returning `RepoStart`; new `prepareAll` signature; rewrite the two doc comments that describe the removed policy.
2. `worktree.spec.ts` — delete the leftover-guard and `reuseBranch` tests; rewrite the branch-creation assertions; add continue-branch, missing-branch, stale-ref, per-repo divergence and malformed-name cases.
3. `prior-work.ts` + `prior-work.spec.ts` (independent of 1 — parallelizable).
4. `wrapper.ts` + `wrapper.spec.ts` (independent).
5. `claude-cli.executor.ts` — `ticketId` and `failing_run_id` into `loadRunConfig`; resolve start refs; `recordStartRefEvent` beside `recordScopingEvent`; wrapper repo mapping.
6. Delete `isResumedAttempt` (declaration, producer, consumer) — after 5 removes the last reader.
7. Integration: the `branchInCache` helpers, and the new two-stage regression suite.
8. Docs and the superseded markers in `specs/019-multi-repo-runs/`.

## Testing

Unit tests carry the git-level behavior (`worktree.spec.ts` builds real local repos) and the pure matching rules (`prior-work.spec.ts`, no DB, no git). The integration suite carries the thing the feature exists for: a two-stage handoff dispatched with source `poll`, asserting the second stage's HEAD is the first stage's commit.

Two integration suites previously used "did the system leave a `run/<ticket>` branch in the cache?" as the discriminator for "was this repo mounted?". That signal is gone by construction. They now read the per-repo `start-ref` timeline entries, which is a direct per-run record rather than an inference over a cache that persists across tests.

## Verification performed

- `pnpm typecheck && pnpm lint && pnpm test` — clean; 353 unit tests pass.
- `pnpm test:integration` — 347/353 pass. The 6 failures live in `runs-cancel-all`, `serve-static`, `dependency-gate` and `sprint-sequencing`, and are PRE-EXISTING: reproduced identically on a clean tree (`git stash -u`, same 4 files, same 6 failures). `callback-completion` failed once under full-suite load and passes in isolation — the same load-dependent flake class documented in iteration 28.
- The new regression suite was run against the pre-change tree and fails all three of its cases, including the silent one: a reported-but-absent branch produced `succeeded` instead of `failed`, i.e. the run started from `main` and reported success — the exact false-success mode the feature closes.

## Complexity tracking

None. The change removes a mechanism (system-owned branches, the leftover guard, `reuseBranch`, `isResumedAttempt`) and adds one small module plus one timeline event.

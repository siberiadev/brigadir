# Research: Linked-Ticket Branch Inheritance + Configurable Dependency Release Status

**Feature**: 032 | **Date**: 2026-07-26 | **Status**: complete — no open NEEDS CLARIFICATION

All spec-level decisions arrived settled (D1–D8, encoded in spec Clarifications). This document
resolves the *implementation-level* unknowns found while reading the touched code.

## R1 — Gate predicate shape and setting threading

**Decision**: `evaluateDependencyGate(issue, opts?: { releaseStatus?: string })` and the same
optional argument on `blockingLinks`/`blockingKeys` in `libs/pipeline/src/dependency-gate.ts`.
A link is *open* iff `inwardIssue.fields.status.statusCategory.key !== 'done'` **AND**
`inwardIssue.fields.status.name` ≠ `releaseStatus` (trimmed, case-insensitive; comparison skipped
when `releaseStatus` is undefined). New accessor `getDependencyReleaseStatus(db, workspaceId)` in
`libs/database/src/workspace-settings.ts` (same pattern as `getReworkMax`). Read **once per
release pass** in `DependencyReleaseService.process` and **once per status-change event** in
`PipelineService.onStatusChanged`.

**Rationale**: the predicate stays pure (unit-testable without DB); both call sites already have
workspace context; per-pass read keeps the release loop at one extra query.

**Alternatives considered**: reading settings inside the predicate (rejected — impure, breaks the
existing unit-test surface); a `WorkspaceSettings`-typed parameter (rejected — the predicate needs
one string, not the blob).

## R2 — `blocked_by` write matrix (always-written observation)

**Decision**: introduce `allBlockedByKeys(issue)` in `dependency-gate.ts` — ALL inward
"is blocked by" keys regardless of blocker status (distinct from `blockingKeys`, which stays "open
under the current threshold"). Write paths change as follows:

| Path | Today | After 032 |
| --- | --- | --- |
| Poller `processIssues` cache advance | writes `last_seen_status` etc. | additionally writes `blockedBy: allBlockedByKeys(issue)` (`[]` when none) on **every** observation |
| `PipelineService.onStatusChanged` blocked branch | `blockedBy: blockingKeys, blockedState: 'waiting'` | `blockedBy: allBlockedByKeys(issue)`, `blockedState: 'waiting'` (state semantics unchanged) |
| `PipelineService.clearWaitingState` | nulls both | nulls **only** `blockedState` |
| Release pass on release (`dependency-release.service.ts` L174-177) | `blockedBy: null, blockedState: null` | `blockedBy: allBlockedByKeys(issue)` (fresh fetch in hand), `blockedState: null` |
| Release pass on still-waiting (`classifyWaiting`) | `blockedBy: w.blockers` (open only) | `blockedBy: allBlockedByKeys(w.issue)`, `blockedState` classification unchanged (classification still runs on **open** blockers) |

`blocked_state` remains the sole "is waiting" signal; every consumer that today infers waiting
from `blocked_by != null` must be audited (dashboard waiting list, fast-path candidates). The
fast-path candidate query (`blockedBy @> [key]`) benefits: the containment now matches released
tickets too, and the `NOT EXISTS active/succeeded run` clause already filters those out.

**Rationale**: D3 verbatim; the observation must exist at prepare time, which is exactly when the
old clear-on-release semantics nulled it.

**Alternatives considered**: a separate `observed_blocked_by` column (rejected — DDL for a cache;
the brief explicitly reuses the existing column with changed meaning); recomputing links at
prepare via Jira (rejected for the *key list* — the poller already has them for free; the live
fetch is reserved for status, see R4).

**Migration note**: no backfill. Rows keep `blocked_by = null` until their next observation; the
spec's "stale/empty cache" edge case covers this (inheritance falls through to default branch and
heals on the next poll).

## R3 — Precedence layering: per-repo, higher level wins, merge only within level 3

**Decision**: resolution builds a per-repository map in `prior-work.ts`:

1. Level 1/2 (own prior work — `preferRunId`, then latest succeeded on this ticket): unchanged,
   produces `continueBranches` exactly as today. Repositories claimed here are **closed** — a
   blocker branch never merges into the ticket's own branch.
2. Level 3 (new `getBlockerWork(db, { workspaceId, blockedByKeys })`): for each blocker key in
   deterministic order (lexicographic key sort), resolve the blocker's ticket row by
   `(workspaceId, jiraKey)`, then its latest succeeded run reporting artifacts (same
   `SCAN_WINDOW = 5` loop as `getPriorWork`), then `matchReportedBranches` against the *still
   unclaimed* mounted repos. First blocker to name a repo becomes its start branch; subsequent
   blockers naming the same repo append to that repo's `mergeBranches` list.
3. Level 4: default branch (implicit — absent from both maps).

Output type: per repo `{ source: 'own' | 'blocker', startBranch, mergeBranches: string[],
blockers: { key, runId, branch }[] }` — consumed by `prepareAll`, the start-ref events and the
wrapper without re-derivation.

**Rationale**: "own work outranks inherited work" (spec US2/S2) is only coherent per repository —
a dependent's own branch was itself based on the blocker's branch when its first run inherited it,
so merging a blocker into it again would re-introduce the drift problem the spec scoped out.
Deterministic blocker order (sorted keys) makes the merge order reproducible (spec US3/S4).

**Alternatives considered**: run-level precedence (own work anywhere ⇒ no inheritance at all;
rejected — a second stage touching repo A would strip repo B's inherited dependency mount);
priority/recency-based blocker ordering (rejected — release order is priority-based, but at
prepare time reproducibility beats cleverness and the merge is commutative when clean).

## R4 — Blocker status at prepare time: live batched Jira fetch

**Decision**: the missing-branch asymmetry (spec FR-008) and the not-done human task need each
blocker's **status category + name** at prepare time. The executor already injects `JIRA_CLIENT`;
prepare performs ONE `key in (<blocker keys>)` search with fields `['status']` — only when
`blocked_by` is non-empty. Results feed (a) the done/not-done branch of the matrix, (b) the
"Linked tickets" wrapper block, (c) the early-release annotation check. A fetch failure fails the
run loudly (`crashed`, diagnostics naming the blockers) — the alternative is guessing which side
of the quiet/task asymmetry applies, i.e. a silent fallback.

**Rationale**: Principle I (Jira is the sole truth for status); freshness matters exactly here —
a blocker may have merged (branch deleted, status Done) minutes before the dependent prepared.
Cost is one call per dependent-with-blockers run.

**Alternatives considered**: caching `status_category` on `tickets` (rejected — DDL + architecture
§3 change, staleness flips behaviour, feature is deliberately no-migration); using
`last_seen_status` name vs the workspace's configured status to *infer* doneness (rejected — the
done category cannot be derived from a name, and cross-project blockers use other workflows).

## R5 — Human-task kinds and dedup without DDL or contract widening

**Decision**: all three tasks are run-less ticket tasks with DB/contract `kind = 'blocker'`. The
spec-level "kind" and dedup tuple (workspace, dependent ticket, blocker key, repository, kind) are
realized by a **deterministic title** with a machine prefix:

- `[blocker_branch_lost] <TICKET>: no usable branch from <BLOCKER> for <repo>`
- `[blocker_merge_conflict] <TICKET>: blocker branches conflict in <repo>`
- `[blocker_repo_unmounted] <TICKET>: blocker <BLOCKER> has work in unmounted <repo>`

New method `HumanTaskService.createTicketBlockedKeyed(workspaceId, ticketId, { title, details })`
— dedup: an **open, run-less** task with the **same ticketId and exact title** exists ⇒ no insert
(returns `{ created: false }`); the existing coarse `createTicketBlocked` (any open run-less task
per ticket, feature 022 out-of-scope path) is left untouched. Details carry the operator guidance
(two fixes for `blocker_repo_unmounted`, resolve-and-rework for conflicts).

**Rationale**: `HumanTaskKindSchema`/`HUMAN_TASK_KINDS` are agent-facing versioned contracts;
widening them for internal diagnostics couples the taxonomy to the report schema. Title equality
over deterministic titles IS the dedup tuple, with zero migration. Recorded as a deliberate
spec-letter deviation in plan.md Complexity Tracking.

**Alternatives considered**: widening the enum (rejected, see plan Complexity Tracking); a
`dedup_key` column (rejected — DDL for what a deterministic string already provides).

## R6 — Multi-blocker merge mechanics in the worktree layer

**Decision**: `prepareAll`/`addRepoWorktree` accept per-repo
`{ startBranch?: string, mergeBranches?: string[] }` (superset of today's `continueBranches`).
After the detached checkout at `origin/<startBranch>`, each merge branch is validated
(`assertSafeBranchName`), verified on origin (`remoteBranchExists`), then merged **sequentially**:
`git -c user.name=brigadir -c user.email=brigadir@system merge --no-ff origin/<branch>` on the
detached HEAD (git supports merges on detached HEAD; `--no-ff` guarantees a merge commit even for
fast-forwardable inputs, so provenance is always visible in the graph). On conflict:
`git merge --abort` (best effort), then `WorktreePrepareError` naming the repo and both branch
sets — `prepareAll`'s existing all-or-nothing unwind handles the rest. `startSha` is resolved
AFTER the last merge — the completion-gate baseline includes the merged work by construction.
`RepoStart` gains `mergedBranches?: string[]` and provenance data for events/wrapper.

Missing-branch handling honours the matrix *before* the git layer: the executor removes gone
branches from the plan (with events/tasks per FR-008) — `worktree.ts` keeps its feature-023
loud-crash contract for anything actually passed to it, EXCEPT that verification of blocker
branches (existence check → drop, not crash) happens in the executor against the fetched cache.
To keep `worktree.ts` a pure git layer, it exposes a `branchExistsOnOrigin(cacheDir, branch)`
probe (extracted from the existing private helper) and `ensureCache` stays the single
fetch-with-prune point; the executor's matrix check runs between `ensureCache` and worktree
creation. This requires splitting `prepareAll`'s loop: ensure caches first (all repos), evaluate
the matrix, then add worktrees — the all-or-nothing unwind semantics are preserved.

**Rationale**: sequential deterministic merges + `--no-ff` give reproducible, auditable start
points; identity via `-c` flags avoids polluting shared cache config; keeping report semantics
out of `worktree.ts` preserves the feature-023 layering ("matching is the CALLER's job").

**Alternatives considered**: octopus merge (`git merge b1 b2`) (rejected — one conflicting pair
aborts the whole octopus with poorer attribution; sequential merges name the exact conflicting
branch); merging in the shared cache clone (rejected — the cache is shared state across runs;
merges belong in the run-private worktree); letting the agent merge (explicitly forbidden by D7).

## R7 — Early-release annotation and unmatched-setting diagnostic

**Decision**: two additions in `dependency-release.service.ts` / `pipeline.service.ts`:

- **Early-release run event** (spec FR-015): at trigger time the caller knows each blocker's
  fresh status. When a release happened with ≥1 blocker satisfied by name-match (not done), insert
  one `run_events` row on the new run: `type: 'log'`, payload `{ source: 'dependency-release',
  early: true, matched_status, blockers: [{ key, status }] }`. Written right after
  `runTrigger.trigger` returns a non-deduplicated `runId`.
- **Unmatched-setting diagnostic** (spec FR-004): once per release pass, when `releaseStatus` is
  configured and NO fetched blocker (across the pass) carries that status name AND ≥1 candidate
  stayed waiting, log a warn naming the setting. The dashboard warning is computed client-side:
  the settings panel compares the configured value against `GET /api/workspaces/:id/statuses`
  (existing endpoint, already used by the agent trigger-status select) and renders a non-blocking
  hint when absent.

**Rationale**: run timeline is the established diagnosis surface (feature 026); the statuses
endpoint already exists — no new API. The pass-level warn avoids per-ticket spam.

**Alternatives considered**: a workspace-level "diagnostics" store (rejected — new entity);
blocking validation on save (rejected by spec — must degrade, not refuse, since blockers may live
in another project whose statuses the board never shows).

## R8 — Wrapper rendering: provenance lines + "Linked tickets" block

**Decision**: `WrapperRepoInfo` grows
`provenance: 'default' | 'continue_own' | 'inherited_blocker' | 'merged_blockers'` plus
`blockerKey?`, `mergedFrom?: { key, branch }[]`, and `prBase?: string` (the branch the agent's PR
should target: the inherited/merged branch name for `inherited_blocker`, the first-merged branch
for `merged_blockers`, absent for own/default). `repositoriesSection` renders one line per
variant, exactly following D7's phrasing (dependency = read/build-against; merged = "already in
your start point; open your PR against <branch>"). The "Linked tickets" block is a new
`linkedTicketsSection(entries)` in `wrapper.ts`, fed by the executor from data it already holds
after R3+R4 (blocker key, live status name, branch, PR URL from the blocker's report entries) —
**no extra fetches**; capped at 10 entries, per-line truncation constants shared with
`feature-context.ts` style (200 chars/line). Rendered inside the wrapper between the
Repositories section and the report section. The existing feature-context section (epic +
generic linked issues) is left as-is; overlap is acceptable (different budgets, different
purpose), consistent with the spec decision "one place = the wrapper's handoff section" for the
authoritative blocker facts.

**Rationale**: the executor is the only place where provenance, live statuses and report
artifacts meet; wrapper stays a pure renderer.

**Alternatives considered**: extending `buildFeatureContextSection` (rejected — it is
callback-channel-only and epic-oriented; blocker provenance must also reach non-callback runs'
`repositoriesSection`, and mixing budgets makes the cap rules ambiguous).

## R9 — Start-ref event vocabulary and presenter

**Decision**: `recordStartRefEvent` in `claude-cli.executor.ts` extends its per-repo payload:
`decision` gains `inherited_from_blocker`, `merged_blockers`, `blocker_branch_merged`,
`blocker_no_artifact`; payload adds `blockers: [{ key, branch, runId }]` and
`mergedBranches: string[]` where applicable. `blocker_artifacts_unmounted` is emitted as a
separate `start-ref`-source event (it names a repo that has NO worktree row). Existing decisions
`report_confirmed` / `default_branch` unchanged. `apps/web/src/components/RunTimeline/presenter.ts`
maps the new decisions to key/value bodies + tags per feature-026 conventions (no JSON dumps).

**Rationale**: D8 verbatim; one event stream keeps the operator story ("open the run, read
start-ref events") intact.

**Alternatives considered**: a new event `type` (rejected — `type: 'log'` with `source:
'start-ref'` is the established shape; presenter keys off source/decision).

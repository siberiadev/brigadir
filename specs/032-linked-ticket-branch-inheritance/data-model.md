# Data Model: Linked-Ticket Branch Inheritance + Configurable Dependency Release Status

**Feature**: 032 | **Date**: 2026-07-26

**No DDL migration in this feature.** All persistence changes are jsonb values, changed write
semantics of an existing column, and new payload shapes inside existing tables.

## 1. `workspaces.settings` — new optional field

```
dependency_release_status?: string   // zod: z.string().trim().min(1).optional()
```

- Home: `WorkspaceSettingsSchema` (`packages/contracts/src/jira.types.ts`), same pattern as
  `rework_max` / `ticket_scoping` ("ABSENT ⇒ byte-identical legacy behaviour. No DDL — jsonb
  value only.").
- Accessor: `getDependencyReleaseStatus(db, workspaceId): Promise<string | undefined>` in
  `libs/database/src/workspace-settings.ts`.
- Comparison rule everywhere: trimmed, case-insensitive against the blocker's live
  `status.name`.
- Dashboard: exposed on the workspace GET payload and PATCH-able via the existing settings
  endpoint (same route as `ticket_scoping`); select options come from the existing
  `GET /api/workspaces/:id/statuses`.

## 2. `tickets.blocked_by` — semantic change (write matrix)

Type unchanged (`jsonb`, `string[] | null`). Meaning changes from "open blockers while waiting,
null otherwise" to **"ALL inward 'is blocked by' keys as last observed on the board"**.
`tickets.blocked_state` keeps today's meaning (waiting classification; null when not waiting) and
becomes the ONLY waiting signal.

| Writer | Trigger | `blocked_by` | `blocked_state` |
| --- | --- | --- | --- |
| Poller `processIssues` | every observation | `allBlockedByKeys(issue)` (`[]` if none) | untouched |
| `PipelineService.onStatusChanged` | gate says blocked | `allBlockedByKeys(issue)` | `'waiting'` |
| `PipelineService.clearWaitingState` | not a trigger status / gate clear | untouched | `null` |
| Release pass — released | trigger fired | `allBlockedByKeys(issue)` (fresh fetch) | `null` |
| Release pass — still waiting | classification | `allBlockedByKeys(issue)` | `waiting\|cycle\|dead_end\|out_of_scope` (classification computed on OPEN blockers, as today) |

Readers to audit (must key off `blocked_state`, not `blocked_by != null`): dashboard waiting
list/endpooint, ticket-history page, fast-path candidate query (containment on `blocked_by` is
still correct — the NOT-EXISTS-run clause filters released pairs).

Backfill: none. `null` rows heal on next observation; prepare treats `null`/`[]` as "no blockers
observed" (default-branch fallthrough).

## 3. Prior-work resolution output (in-memory contract, `prior-work.ts`)

```ts
interface RepoStartPlan {
  source: 'own' | 'blocker' | 'default';
  startBranch?: string;              // absent ⇔ source 'default'
  mergeBranches: string[];           // non-empty only for source 'blocker', 2+ blockers
  blockers: { key: string; runId: string; branch: string }[]; // provenance (events + wrapper)
}
// per run: Record<repoName, RepoStartPlan> + unmounted: { key, repo, branch }[]
```

Level-3 resolution inputs: `tickets.blocked_by` (keys, sorted lexicographically) →
`tickets(workspaceId, jiraKey)` → latest succeeded run with artifact entries (`SCAN_WINDOW = 5`)
→ `matchReportedBranches` against still-unclaimed mounted repos.

## 4. `RepoStart` (worktree layer) — extended

```ts
interface RepoStart {
  startRef: string;
  startSha: string;                  // resolved AFTER merges — completion-gate baseline
  continueBranch?: string;           // unchanged (own-work continuation)
  mergedBranches?: string[];         // branches merged into the start point, in merge order
}
```

`prepareAll` opts: `continueBranches: Record<string, string>` (unchanged) plus
`mergeBranches?: Record<string, string[]>`.

## 5. `run_events` payloads (existing table, `type: 'log'`)

### 5a. Per-repo start-ref event (extends feature-024 shape)

```jsonc
{
  "source": "start-ref",
  "repo": "product",
  "decision": "report_confirmed" | "default_branch"           // existing
            | "inherited_from_blocker"                        // one blocker branch
            | "merged_blockers"                               // 2+ blocker branches merged
            | "blocker_branch_merged"                         // blocker done, branch gone → default, quiet
            | "blocker_no_artifact",                          // blocker NOT done, nothing usable → default + task
  "message": "<human sentence>",
  "continueBranch": "run/A" | null,
  "startSha": "<sha>",
  "reportedByRunId": "<uuid>" | null,
  "blockers": [{ "key": "ST3-101", "branch": "run/A", "runId": "<uuid>" }],   // new, when relevant
  "mergedBranches": ["run/B", "run/C"],                                        // new, merged_blockers only
  "unmatchedReportedRepos": ["..."]                                            // existing
}
```

### 5b. Unmounted blocker artifacts (repo has no worktree row)

```jsonc
{
  "source": "start-ref",
  "decision": "blocker_artifacts_unmounted",
  "repo": "<unmounted repo name>",
  "blockers": [{ "key": "ST3-101", "branch": "feature/x", "runId": "<uuid>" }],
  "message": "<names the two fixes>"
}
```

### 5c. Early-release annotation (on the dependent's new run)

```jsonc
{
  "source": "dependency-release",
  "early": true,
  "matched_status": "In Review",
  "blockers": [{ "key": "ST3-101", "status": "In Review" }]
}
```

## 6. Human tasks (existing table, no new columns)

All three are run-less ticket tasks, `kind: 'blocker'`, `blocking: false`, `status: 'open'`.
The spec-level kind + dedup tuple (workspace, ticket, blocker, repo, kind) is realized by a
deterministic title (research R5); dedup = open run-less task with same `ticket_id` + exact
`title`.

| Machine prefix | Title shape | Details must contain |
| --- | --- | --- |
| `[blocker_branch_lost]` | `[blocker_branch_lost] <T>: no usable branch from <B> for <repo>` | that the run started from the default branch; blocker status at the time; what to check (blocker's report/branch) |
| `[blocker_merge_conflict]` | `[blocker_merge_conflict] <T>: blocker branches conflict in <repo>` | the branch list in merge order; that the run failed; resolve-then-rework guidance |
| `[blocker_repo_unmounted]` | `[blocker_repo_unmounted] <T>: blocker <B> has work in unmounted <repo>` | the two fixes: add the Component to `<T>`, or widen the agent's repository scope |

## 7. Wrapper view-model (in-memory, `wrapper.ts`)

```ts
interface WrapperRepoInfo {
  name: string; absPath: string; defaultBranch: string;
  continueBranch?: string;                                   // existing
  provenance: 'default' | 'continue_own' | 'inherited_blocker' | 'merged_blockers';
  blockerKey?: string;                                       // inherited_blocker
  mergedFrom?: { key: string; branch: string }[];            // merged_blockers
  prBase?: string;                                           // PR target the agent is told
}

interface LinkedTicketEntry {                                 // "Linked tickets" block, cap 10
  key: string; status: string; branch?: string; prUrl?: string;
}
```

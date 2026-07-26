# Contract: Configurable Dependency Release

**Feature**: 032 | Covers spec FR-001…FR-005, FR-015, FR-016 (gate half)

## 1. Gate predicate (`libs/pipeline/src/dependency-gate.ts`)

```ts
evaluateDependencyGate(issue: JiraIssue, opts?: { releaseStatus?: string }): 'clear' | 'blocked'
blockingKeys(issue: JiraIssue, opts?: { releaseStatus?: string }): string[]
allBlockedByKeys(issue: JiraIssue): string[]   // NEW: all inward blocked-by keys, any status
```

Link-open rule (a link gates iff ALL of):

1. `link.inwardIssue` present and `link.type.inward.toLowerCase() === 'is blocked by'`;
2. `inwardIssue.fields.status.statusCategory.key !== 'done'`;
3. `releaseStatus` undefined **OR**
   `inwardIssue.fields.status.name.trim().toLowerCase() !== releaseStatus.trim().toLowerCase()`.

Decision table (blocker B of dependent T, setting S):

| S | B status name | B category | Link satisfied? |
| --- | --- | --- | --- |
| unset | any | done | yes |
| unset | any | not done | no |
| "In Review" | "In Review" (any case) | not done | yes |
| "In Review" | "in review " (trailing space in S or name) | not done | yes (trimmed) |
| "In Review" | "In Progress" | not done | no |
| "In Review" | anything | done | yes (OR-done guard) |
| "Nonexistent" | any | not done | no — degrades to done-category rule |

`evaluateDependencyGate` = 'blocked' iff ≥1 unsatisfied link. Outward "blocks" / "relates to"
never gate (unchanged).

## 2. Setting accessor (`libs/database/src/workspace-settings.ts`)

```ts
getDependencyReleaseStatus(db, workspaceId): Promise<string | undefined>
```

Reads `WorkspaceSettingsSchema.parse(settings).dependency_release_status`. Absent/empty ⇒
`undefined` ⇒ callers pass no `releaseStatus` ⇒ byte-identical legacy behaviour (FR-016).

## 3. Call sites (both MUST pass the same setting — FR-003)

- `PipelineService.onStatusChanged`: read once per event (workspace id available on the ticket
  row it already loads), pass to the gate + `blockingKeys` log line.
- `DependencyReleaseService.process`: read once per pass (it has `ws.id`), pass to the gate for
  every candidate. `classifyWaiting` keeps classifying on OPEN blockers under the same threshold
  (a name-satisfied blocker is not "waiting on" anymore). Everything else — candidates query,
  scope re-fetch, release order, fast path, cycle/dead_end/out_of_scope — unchanged.

## 4. Early-release annotation (FR-015)

After a non-deduplicated `runTrigger.trigger` in the release pass or status-change path, when
≥1 inward link was satisfied ONLY by the name-match (blocker category ≠ done at the evaluated
fetch), insert one `run_events` row on the new run (payload §5c of data-model.md). No event when
all blockers were done-category (today's shape stays clean).

## 5. Unmatched-setting diagnostic (FR-004)

- Server: once per release pass — if `releaseStatus` is set, ≥1 candidate remained waiting, and
  no blocker fetched in the pass carried the configured name ⇒ `logger.warn` naming the setting
  value and the workspace.
- Dashboard: settings panel compares the saved value against
  `GET /api/workspaces/:id/statuses` (existing endpoint) and shows a non-blocking warning chip
  ("status not observed on this board — the done-category rule still applies") when absent.
  Free-text entry is allowed (`el-select` with `allow-create`): blockers may live in another
  project.

## 6. Dashboard API delta

- `GET /api/workspaces/:id` (settings view payload): add `dependency_release_status: string | null`
  next to `ticket_scoping` (workspaces.controller.ts ~L926 shape).
- `PATCH` settings route (same one `ticket_scoping` uses): accept optional
  `dependency_release_status: string | null` — `null`/empty clears the key from the blob
  (delete, not store-empty), non-empty trimmed string stores it. Validation: string only; NO
  existence check against the board workflow (degrade-not-refuse per spec).

## 7. Test contract (minimum)

Unit (`dependency-gate.spec.ts`, lib-level):
- every row of the decision table above;
- `allBlockedByKeys` returns done-category blockers too; ignores outward links.

Integration (`test/integration/dependency-gate.spec.ts` extension):
- setting configured → blocker moved to that status (not done) → dependent triggered via release
  pass; with setting unset → same fixture stays waiting (regression);
- blocker jumps In Progress → Done (never observed in the configured status) → dependent released;
- early-release run event present with `matched_status`; absent for done-category release.
- `sprint-sequencing.spec.ts` green unchanged (FR-016 regression).

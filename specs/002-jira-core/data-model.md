# Data Model — Jira Core (iteration 2)

Builds on the iteration-1 schema (`docs/architecture.md` §3, implemented
as-is). This iteration adds **two columns** and formalizes the
`workspaces.settings` blob. No other schema changes.

## Schema delta (migration `0001_jira_board.sql`)

```sql
ALTER TABLE workspaces
  ADD COLUMN jira_board_id   integer,
  ADD COLUMN jira_board_type text;   -- 'kanban' | 'scrum'
```

- Nullable to apply on the existing row; the seeder/connection flow populates
  them via Agile board introspection (`GET /rest/agile/1.0/board/{id}`).
- Reviewed against `docs/architecture.md` §3 (already updated for board
  binding) in `drizzle/REVIEW-0001_jira_board.md` — SQL-vs-doc review is
  mandatory (Constitution governance / CLAUDE.md rule 5).
- **No column** for `scope_jql`, high-water mark, or `active_sprint_id` — all
  live in `workspaces.settings` (jsonb).

## `workspaces.settings` blob (typed accessor in `libs/database`)

```jsonc
{
  "scope_jql": "labels = ai-pipeline",   // optional global filter, ANDed into every poll
  "reconcile": {
    "high_water_mark": "2026-07-11T09:12:33.000Z", // max observed issue `updated`
    "active_sprint_id": 4123                        // last-seen open sprint (scrum only)
  }
}
```

- A zod `WorkspaceSettingsSchema` (in `packages/contracts`) validates the blob;
  typed get/set helpers avoid ad-hoc jsonb access. Absent fields = defaults
  (no filter, HWM = epoch/first-run window, no known sprint).

## Config schema delta (`packages/contracts` `WorkspaceConfigSchema`)

| Key | Type | Status this iteration |
|---|---|---|
| `board_id` | int | **functional** — introspected → `jira_board_id`/`jira_board_type` |
| `scope_jql` | string? | **functional** — persisted to `settings.scope_jql` |
| `branch_prefix` | string? | validated, **unused** until iteration 3 |
| `repositories[]` | `{name, url, default_branch}[]`? | validated, **unused** until iteration 3 |
| `repo`, `default_branch` | string? | deprecated-optional (seed back-compat) |

Fail-fast startup validation MUST accept the full documented `docs/spec.md`
§0.1 example (FR-039).

## Entities & how they map

| Entity (spec) | Storage | Notes |
|---|---|---|
| Workspace | `workspaces` (+ board cols, settings blob) | source of Jira auth + ingest scope |
| Board | `workspaces.jira_board_id/type` | type fixed at connect via Agile API |
| Sprint / active-sprint id | `settings.reconcile.active_sprint_id` | drives sprint-switch rescan |
| High-water mark | `settings.reconcile.high_water_mark` | bounds next poll; guarantees catch-up |
| Ticket | `tickets` (`last_seen_status`, `last_seen_updated`) | `last_seen_status` = diff cache only (Principle I) |
| Blocking dependency | *(not persisted)* | evaluated live from Jira `issuelinks` |
| Agent | `agents` (`trigger_status`, `status_running/success/failure`) | match key = `trigger_status` |
| Run | `runs` (+ `run_events` `jira_action` marker) | non-idempotent; watchdog target; drift-repair unit |
| Run report & checks | `runs.report`/`runs.outcome`, `run_checks` | drive transition + ADF comment |
| Human task | `human_tasks` | needs_human dedup already in `RunsService` |
| Transition-discovery cache | in-memory (client) | keyed project+issuetype+fromStatus, TTL 10 min, 409-invalidated |

## Run completion write-ordering (FR-022, closes F2)

```
finalizeWithReport / finalizeStatus   (Postgres — already exists)
        │  (result persisted; terminal-immutable)
        ▼
PipelineService.onRunFinished(run)     (Jira — NEW)
        │  outcome=success  → transitionTo(status_success) + comment(buildRunComment)
        │  outcome=failure|needs_human → transitionTo(status_failure) + comment
        │  (needs_human: human_task already created by RunsService — no duplicate)
        ▼
INSERT run_events(type='jira_action')  (pending-write marker cleared)
```

A crash **between** persist and Jira write leaves a terminal run with **no**
`jira_action` marker → drift repair re-applies (idempotent per FR-023). Jira
writes go only through the per-issue write queue (Principle III).

## Trigger gating (onStatusChanged / dependency re-eval)

```
onStatusChanged(ticket, from, to, issue, source):
  agents = enabled WHERE trigger_status == to
  for agent in agents:
    if evaluateDependencyGate(issue) == BLOCKED: log skip; continue      # FR-034
    RunTriggerService.trigger(ticketId, agentId, triggerEvent)           # 3 dedup layers
```

`evaluateDependencyGate(issue)` = BLOCKED iff any inward "is blocked by" link
has `inwardIssue.fields.status.statusCategory.key !== 'done'` (D10).

## Poller scope JQL (by board type)

| Board | JQL (conceptual) |
|---|---|
| kanban | `project = {key} [AND {scope_jql}] AND updated >= "{HWM-60s}"` |
| scrum | `project = {key} AND sprint IN openSprints() [AND {scope_jql}] AND updated >= "{HWM-60s}"` |
| scrum, sprint switch | as scrum **without** the `updated` clause, one-off (D9) |
| scrum, no active sprint | *(no query — idle no-op, FR-030)* |

`fields`: `status,summary,updated,issuelinks`. Pagination: `nextPageToken`
loop (no `total`).

## State transitions touched this iteration

Run lifecycle is unchanged from iteration 1; this iteration adds the **Jira
side-effects** attached to terminal transitions and the **watchdog** path:

- `running` → (`timeout_minutes`+grace exceeded, watchdog) → `timed_out`/`failed`
  + failure-outcome Jira treatment.
- terminal (`succeeded`/`failed`) with no `jira_action` marker → drift repair
  applies the pending transition/comment (does not change run status).

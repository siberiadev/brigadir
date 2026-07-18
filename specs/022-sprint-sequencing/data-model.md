# Data Model — sprint-sequencing (Phase 1)

## 1. `tickets` — four new nullable diff-cache columns

All four are **observed-board caches** (same contract as `last_seen_status`): written only from Jira data, never authoritative, re-derived every release pass. No backfill needed — NULL means "not observed yet / not waiting".

| Column | Type | Meaning |
|---|---|---|
| `priority_id` | `int NULL` | Numeric Jira priority id parsed from `fields.priority.id`; NULL when the field is absent or unparseable. Ascending = more important (built-in scheme: 1 Highest … 5 Lowest). |
| `priority_name` | `text NULL` | Display name (`fields.priority.name`) for the dashboard; never used for ordering. |
| `blocked_by` | `jsonb NULL` | Array of blocker issue keys (`["BRIG-1","BRIG-7"]`) — the open inward "is blocked by" links at last evaluation. NULL when the ticket is not in a blocked-waiting condition. |
| `blocked_state` | `text NULL` | `waiting \| cycle \| dead_end \| out_of_scope`; NULL when not blocked-waiting. See state rules below. |

Drizzle schema: `libs/database/src/schema/tickets.ts`; migration checked into `drizzle/`.

### `docs/architecture.md` §3 synchronized DDL (rule 5 — same change)

```sql
CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  jira_key        text NOT NULL,
  jira_id         text NOT NULL,
  summary         text,
  last_seen_status text,                       -- кэш для diff, НЕ источник правды
  last_seen_updated timestamptz,
  priority_id     int,                         -- кэш Jira priority.id (feature 022); ASC = важнее; NULL = без приоритета
  priority_name   text,                        -- кэш имени приоритета для дашборда (feature 022)
  blocked_by      jsonb,                       -- кэш открытых blocked-by ключей (feature 022); NULL = не ждёт
  blocked_state   text,                        -- waiting | cycle | dead_end | out_of_scope (feature 022); NULL = не ждёт
  UNIQUE (workspace_id, jira_key)
);
```

## 2. `blocked_state` lifecycle

```
NULL ──(gate=blocked at trigger-status entry / release pass)──▶ waiting
waiting ──(cycle detected among waiting trigger-status tickets)──▶ cycle
waiting ──(a blocker has resolution set but non-done category)──▶ dead_end
waiting ──(a blocker fails the scope probe)──▶ out_of_scope   [+ run-less human task, deduped]
any ──(gate=clear → run triggered | ticket left trigger status)──▶ NULL  (blocked_by also NULLed)
```

Rules:
- Classification precedence when several apply: `cycle` > `out_of_scope` > `dead_end` > `waiting` (a cycle is the strongest "will never self-resolve" signal).
- Transitions are recomputed from scratch each release pass — states are not sticky; a human fixing the board flips the state on the next pass (spec Story 4 scenario 3).
- Writers: `PipelineService.onStatusChanged` blocked-skip branch (sets `waiting` + keys immediately at first observation) and `DependencyReleaseService` (full reclassification each pass; clearing on release). `PollerService.processIssues` clears both columns whenever a ticket's observed status is NOT any enabled agent's trigger status.

## 3. Priority ingestion

- `POLL_FIELDS` (moving to `libs/jira/src/scope-jql.ts`, R6) gains `'priority'`.
- `JiraIssue['fields']` (packages/contracts) gains `priority?: { id: string; name: string }`.
- Written on every ticket upsert/update in `PollerService.processIssues` and refreshed by the release pass's batched fetch (both use `POLL_FIELDS`).

## 4. Release ordering (canonical comparator)

Used identically in the release loop (in-memory sort before triggering) and the dashboard SQL:

```
ORDER BY priority_id ASC NULLS LAST, jira_key ASC
```

`jira_key` comparison is plain lexicographic — stable and deterministic, which is the requirement (FR-006); numeric-suffix awareness is deliberately NOT implemented (BRIG-10 < BRIG-9 lexicographically is acceptable and documented — determinism, not aesthetics).

## 5. `human_tasks` — no schema change

Run-less blocked-ticket tasks reuse the existing table: `run_id = NULL` (nullable since feature 011), `ticket_id = <ticket>`, `kind='blocker'`, `blocking=false`. Dedup invariant: **at most one `status='open'` row per `(ticket_id)` with `run_id IS NULL`** — enforced in `HumanTaskService.createTicketBlocked` (query-then-insert like the FR-020 guard; the reconcile pass is single-flight per workspace so no concurrent-writer race exists on this path).

## 6. Entities ↔ spec mapping

| Spec entity | Realization |
|---|---|
| Ticket (+priority, +dependency links) | `tickets` + 4 new columns |
| Dependency link | derived per pass from fresh `issuelinks` (gate unchanged in `dependency-gate.ts`); cached keys in `blocked_by` |
| Waiting state | `blocked_by` + `blocked_state` |
| Release event | one `DependencyReleaseService` pass (reconcile step 2 or fast path); produces ordered `RunTriggerService.trigger` calls |
| Sequencing warning | `blocked_state ∈ {cycle, dead_end, out_of_scope}` rows (+ structured logs; out_of_scope additionally a human task) |

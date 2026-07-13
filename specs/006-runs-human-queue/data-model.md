# Phase 1 — Data Model: Runs Visibility & Human Queue

**Verdict: no structural schema change.** Every entity this feature displays or mutates
already exists in architecture §3 and in `libs/database/src/schema/`. The feature reads
`runs`, `run_checks`, `run_events`, `human_tasks`, `executors`, `tickets`, `workspaces`
and invokes existing write paths. Two **additive, non-structural** items are introduced —
both permitted by the spec Assumptions ("if a read query needs a supporting index, that is
an implementation detail") and neither alters a column or constraint in architecture §3:

1. A **supporting index** for the workspace-scoped runs table read (R7).
2. A **jsonb-embedded flag** `settings.enabled` for the workspace pause toggle (R3) — no
   DDL at all.

---

## Entities (existing — read/rendered)

### Run — `runs` (`schema/runs.ts`)
Read for the runs table (US3) and the card (US2). Cancel/retry drive existing paths (R6).

| Field | Use in this feature |
|-------|---------------------|
| `id` | card + row key |
| `workspaceId` | runs-table scope; cost sum |
| `ticketId` | join to `tickets` for key/summary/deep-link; run-history grouping |
| `agentId` | agent name (join `agents`), agent filter |
| `executorType` | card run-history "executor" column |
| `status` | table column, card status, filter; **cancel guard target** (`WHERE status='running'`) |
| `attempt` | table + card |
| `startedAt` / `finishedAt` | duration = finished−started (running: now−started) |
| `costUsd` | table + card cost; workspace cost sum |
| `usage` | card (optional detail) |
| `error` | card failure diagnostics (FR-011) |
| `report` | present, but the checklist renders from `run_checks` (below), not this blob |
| `outcome` | card run-history outcome column |
| `createdAt` | table ordering (`desc`), age |

Status vocabulary (unchanged): `queued | running | awaiting_human | succeeded | failed |
cancelled | timed_out | superseded`.

**Invariant preserved (constitution rule #7 / FR-012)**: outcome/operator-derived status
writes are guarded to `WHERE status='running'`. The card's cancel is exactly such a write
and MUST carry the guard so it never overwrites `awaiting_human`.

### Run check — `run_checks` (`schema/run-checks.ts`)
The checklist source (FR-008). `position` (order), `name`, `status` ∈ `pass|fail|warn|skip`
→ ✅/❌/⚠/⏭, `reason` (revealed on expand). Rendered ordered by `position`. A run with zero
rows renders an empty checklist without error (spec Edge Case "report with no checks").

### Run event — `run_events` (`schema/run-events.ts`)
The timeline source (FR-010). `type` ∈ `progress|log|tool_call|api_retry|error|jira_action`,
`payload` jsonb, `createdAt`. Rendered chronologically by `id` (monotonic identity). `error`
/`log` rows feed the failure diagnostics block (FR-011).

### Human task — `human_tasks` (`schema/human-tasks.ts`)
The queue source (US1). `kind` ∈ `question|blocker|review`, `title`, `details`, `blocking`,
`status` ∈ `open|resolved|dismissed`, `resolution`, `resolvedBy`, `resolvedAt`, `runId`
(blocked run), `ticketId`, `createdAt` (age). Open list + history filter + badge count read
from here; resolve writes go through the existing `ResumeService` (unchanged). The existing
`human_tasks_open` partial index already supports the open-count/open-list reads.

### Executor — `executors` (`schema/executors.ts`)
Full CRUD surface + default seeding (US4). `type`, `name`, `config` jsonb (typed per type —
R5), `secrets` bytea (encrypted; never serialized in responses), `concurrencyLimit` (column;
the live-worker slot count, summed per type — R4), `enabled`. `executors_workspace_name`
unique index makes seeding insert-if-absent and enforces unique names per workspace. **No
column change** — `concurrency_limit` is the existing column; all other typed fields live in
the existing `config` jsonb.

### Ticket — `tickets` (`schema/tickets.ts`)
Read for `jira_key` + `summary` + deep-link construction and to group a ticket's run history.
Not mutated by this feature (Jira remains the board — FR-034).

### Workspace — `workspaces` (`schema/workspaces.ts`)
Owns executors/agents/runs. Provides `jira_site_url` (deep-link base) and the repositories
(`settings.repositories`) offered in the claude_cli executor config. **Gains no column** —
the pause flag is `settings.enabled` (below).

---

## Additive item 1 — supporting index for the runs table (R7)

The runs-table read is workspace-scoped, ordered `created_at desc`, paginated, filtered by
agent/status and ticket-key substring. The existing indexes are `runs_one_active` (partial,
active-status only) and `runs_ticket` `(ticket_id, created_at desc)` — neither serves a
`workspace_id`-scoped, time-ordered scan.

**Add** (Drizzle migration, additive, checked in per constitution rule #5):
```
index('runs_workspace_created').on(runs.workspaceId, runs.createdAt.desc())
```
This is a **non-structural** change (an index, not a column/constraint), so architecture §3's
table definition is unchanged; the migration is reviewed and committed like any other. The
agent/status filters are low-cardinality and ride the same scan; ticket-key search resolves
via the join to `tickets` (already keyed by `jira_key`). The workspace cost sum reuses this
index over the `created_at` period window.

## Additive item 2 — workspace pause flag in `settings` (R3, FR-028/FR-030)

**No DDL.** The enabled/paused flag is `workspaces.settings.enabled: boolean`, **absent ⇒
treated as `true`** (every existing workspace stays polled with no backfill).

- **Read (reconcile pass, FR-028)**: select enabled workspaces —
  `settings->>'enabled' is distinct from 'false'` — a disabled workspace is skipped
  entirely. Workspace count is tiny; no index required.
- **Write (FR-030)**: the workspace settings endpoint (feature 005) merges `enabled` into
  `settings`, alongside `repositories`.
- **Contract**: `WorkspaceSettings` in `packages/contracts` gains optional
  `enabled?: boolean`.

Rationale and the alternative (a real `boolean enabled` column, deferred) are in research.md
R3. If a later feature needs to index/query this heavily, promoting it to a column is a
clean standalone migration.

---

## Relationships used (all existing FKs)

```
workspace 1─* runs ─* run_checks
                └─* run_events
workspace 1─* human_tasks *─1 run   (human_tasks.run_id, nullable)
run *─1 ticket ; run *─1 agent ; agent *─1 executor (confirm ref column in design — R5)
workspace 1─* executors ; workspace 1─* agents
```

## No new tables · No new columns · Two additive items only

| Change | Kind | Migration? | Architecture §3 impact |
|--------|------|-----------|------------------------|
| `runs_workspace_created` index | additive index | yes (checked in) | none (non-structural) |
| `settings.enabled` flag | jsonb value | no | none |
| everything else (reads + reused writes) | — | no | none |

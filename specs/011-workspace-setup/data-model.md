# Phase 1 Data Model: Workspace Setup by the Orchestrator + Read-Only Jira Tools

Grounded in `docs/architecture.md` §3 and the live drizzle schema in `libs/database/src/schema/`.
Schema changes ship as migration `drizzle/0005_workspace_setup.sql` with
`REVIEW-0005_workspace_setup.md` reviewed against §3 (rule 5); §3/§5/§6 of the architecture
doc are updated in the same change (D17).

---

## 1. Schema changes (persisted)

### 1.1 `runs.ticket_id` — NOT NULL dropped (`libs/database/src/schema/runs.ts:28-30`)

| Column | Was | Becomes | Purpose |
|--------|-----|---------|---------|
| `ticket_id` | `uuid NOT NULL REFERENCES tickets(id)` | `uuid NULL REFERENCES tickets(id)` | Setup runs carry no ticket (D2). FK kept. |

### 1.2 `human_tasks.ticket_id` — NOT NULL dropped (`libs/database/src/schema/human-tasks.ts:19-21`)

| Column | Was | Becomes | Purpose |
|--------|-----|---------|---------|
| `ticket_id` | `uuid NOT NULL REFERENCES tickets(id)` | `uuid NULL REFERENCES tickets(id)` | Review / setup-failure / setup-question tasks carry no ticket. FK kept. |

### 1.3 New partial unique index `runs_one_active_setup` (D3)

```sql
CREATE UNIQUE INDEX runs_one_active_setup ON runs (workspace_id)
  WHERE status IN ('queued','running','awaiting_human') AND ticket_id IS NULL;
```

- `runs_one_active` (`(ticket_id, agent_id)` partial, `drizzle/0000_init.sql:135`) is untouched —
  it cannot cover NULL ticket rows (unique-index NULLs are distinct), hence the companion index.
- Guarantees at most ONE active ticketless run per workspace; `RunTriggerService.trigger` catches
  `23505` from either index identically (existing dedup contract, `run-trigger.service.ts:91-108`).

### 1.4 No other DDL

- New workspaces are paused via `settings.enabled=false` at creation (jsonb value, no DDL — D14).
- The setup completion marker reuses `run_events(type='jira_action')` payload (§3.2 below).
- No new tables. Executor profiles, agents, tickets unchanged.

**Migration outline `0005_workspace_setup.sql`:**

```sql
ALTER TABLE runs        ALTER COLUMN ticket_id DROP NOT NULL;
ALTER TABLE human_tasks ALTER COLUMN ticket_id DROP NOT NULL;
CREATE UNIQUE INDEX runs_one_active_setup ON runs (workspace_id)
  WHERE status IN ('queued','running','awaiting_human') AND ticket_id IS NULL;
```

No backfill: historical rows keep their tickets (spec assumption).

---

## 2. Contract entities (not persisted as tables)

### 2.1 Report `team` outcome (`packages/contracts/src/report.schema.ts`) — D9

```
REPORT_OUTCOMES += 'team'
team?: { agents: TeamAgent[] }        // min 1, max 20, .strict()
TeamAgent = {
  name:            string ≤200        // must not equal the orchestrator's name
  description:     string ≤500        // roster line (agents.description)
  instruction:     string ≤8000
  trigger_status:  string ≤100
  status_running?: string ≤100
  status_success:  string ≤100
  status_failure:  string ≤100
  executor:        string ≤200        // executor PROFILE NAME, resolved server-side
}.strict()
superRefine: outcome==='team' ⇒ team required (mirrors routed/needs_human)
```

- `description`/`instruction` pass the secret scrubber (`scrubReport` extension); identifiers
  (name/statuses/executor) stay unscrubbed like `routing.target_agent`.
- Business validation is NOT in the zod schema (same split as `routed`): it runs in the
  accept-path validator (§3.1).

### 2.2 Trigger-event vocabulary (`packages/contracts/src/trigger-event.schema.ts`) — D1

```
TRIGGER_SOURCES += 'workspace-setup'
MOCK_SCENARIOS  += 'team', 'team_invalid'
```

Handoff-source classification gains:

| `source` | handoff kind | references |
|----------|-------------|-----------|
| `workspace-setup` | setup handoff (project digest + protocol; + Q&A when resumed) | `human_task_id?`, `resolution?` |

BullMQ dedup: `workspace-setup` joins the skip-set alongside `CONTINUATION_SOURCES`
(`run-trigger.service.ts:31`); the DB index (§1.3) is the authority.

### 2.3 Run token claims (`packages/contracts/src/run-token.ts`) — D4

`tkt` becomes optional (`tkt?: string`). No guard change — `RunTokenGuard` verifies only
`sub` + DB run status (`run-token.guard.ts:51-86`).

### 2.4 Read-tool schemas (`packages/contracts/src/callback-tools.schema.ts`) — D5/D8

```
GetProjectOverviewSchema = {}                                    .strict()
SearchTicketsSchema      = { text?: string ≤200, status?: string ≤100,
                             issue_type?: string ≤100, max_results?: int 1..50 } .strict()
GetTicketSchema          = { key: string ≤50 }                   .strict()
```

Response shapes (size bounds per D8): overview `{board_type, project_key, statuses[],
issue_types[], active_sprint?}`; search `{items[≤50]: {key,summary,status,issue_type,
assignee?,updated}, truncated}`; ticket `{key,summary,status,issue_type,labels[],
description(≤4000), links[], comments[≤20]: {author,created,body(≤1500)}, truncated}`.

### 2.5 Dashboard response deltas — D16

```
RunListItem.ticket   : RunTicketRefSchema.nullable()     (runs.schema.ts:46)
RunCardResponse.…    : ticket nullable                    (runs.schema.ts:116/139)
HumanQueueItem.ticket: HumanTaskTicketRefSchema.nullable() (human-queue.schema.ts:31)
RunListQuery         : += source? (trigger-source filter; D11)
```

`ResolveHumanTaskSchema.target_agent_id` — rejected (422) when the task is ticketless (D12).

### 2.6 Generate endpoint contract — D11

`POST /api/workspaces/:id/generate-agents` → `202 {run_id}` |
`409 {error: 'worker_agents_exist' | 'setup_run_active' | 'no_orchestrator'}` |
`404`. See `contracts/generate-agents-api.md`.

---

## 3. State & lifecycle

### 3.1 Setup completion (accept-path transaction) — D9/D10

```
complete_task(outcome='team')
  → schema validation (zod)            invalid → 422 (as today)
  → business validation (all-or-nothing):
      names unique (proposal ∪ existing agents ∪ 'brigadir')
      statuses ∈ live board workflow (lintAgent + StatusesService refresh)
      executor name → existing ∧ enabled profile
      duplicate_trigger lint across proposal ∪ existing enabled agents
    invalid → 422 {issues[]} — agent may fix and re-submit complete_task (repair loop)
  → ONE transaction: insert N agents (enabled=true) + insert review human task
    (kind='review', blocking=false, ticket_id=NULL, run_id=setup run)
    + finalize run 'succeeded'
```

Invariant: a `succeeded` setup run ⇔ its team and review task exist (atomic).
A setup run that exits without an accepted proposal → existing fail-closed path →
`failed` + orchestrator-failure human task carrying the last validation issues.

### 3.2 Pipeline completion marker (replay idempotency) — D10

`onRunFinished` orchestrator branch, `source==='workspace-setup'`:

```
marker payload: { setup: 'applied', agents_created: n }   (succeeded)
                { setup: 'failed' }                        (failed/timed_out — after human task)
```

Replay (drift repair) re-reads `hasJiraActionMarker` and no-ops. No Jira writes on this path.

### 3.3 Setup-run source transitions

```
POST generate-agents  [no workers ∧ enabled orchestrator ∧ no active setup]
  └─▶ setup run (source='workspace-setup', agent=brigadir, ticket=NULL, no repo)
        ├─▶ complete_task(team, valid)   ──▶ agents created (enabled) + review task; workspace stays paused
        ├─▶ complete_task(team, invalid) ──▶ 422 back to agent ──▶ retry within run … or fail-closed
        ├─▶ request_human(blocking)      ──▶ ticketless task parks run
        │      └─ resolve(resume) ──▶ NEW setup run (+human_task_id, +resolution); picker hidden/rejected
        ├─▶ needs_human                  ──▶ ticketless human task, run awaiting terminal per existing rules
        └─▶ failed / timed_out           ──▶ ticketless failure human task; NEVER triaged
Human: review team in Agents tab → resolve review task → Start workspace (settings.enabled=true)
```

### 3.4 What setup runs are exempt from (D12 / FR-006)

No Jira transitions (`onRunStarted`/`onWorkerFinished` ticket paths skipped — no ticket),
no Jira comments, no rework-budget participation (`getReworkBudget` keys off ticket),
no triage on failure (orchestrator branch already bypasses `decideTriage`).

---

## 4. Validation rules

| Field / action | Rule | Source |
|----------------|------|--------|
| `report.team` | required iff `outcome==='team'`; else forbidden | FR-013 |
| `team.agents` | 1..20 items | FR-013/D9 |
| `team` from non-setup run | rejected → failure, invalid outcome noted | FR-014 |
| agent names | unique in proposal ∪ existing ∪ orchestrator name | FR-015 |
| statuses | every referenced status on live board (`status_absent` lint) | FR-015 |
| `executor` | resolves to existing ∧ enabled profile | FR-015 |
| triggers | `duplicate_trigger` lint across proposal ∪ existing enabled | FR-015/D9 |
| apply | all-or-nothing, one tx with review task + finalize | FR-016/D10 |
| generate preconditions | no workers ∧ enabled orchestrator ∧ no active setup | FR-002 |
| active setup uniqueness | endpoint check + `runs_one_active_setup` | FR-004/D3 |
| read tools | workspace-scoped (server-composed JQL / project check); no writes | FR-009/010, D6 |
| read responses | size-bounded, `truncated` flagged | FR-011/D8 |
| resolve ticketless task | `target_agent_id` rejected; resume → new setup run | D12 |
| new workspace | `settings.enabled=false` at creation (wizard + seeder) | FR-001/D14 |

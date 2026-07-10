# Migration Review — `0000_init.sql` vs architecture.md §3 (task T014)

**Reviewer**: implementation pass, iteration 1 · **Date**: 2026-07-10
**Verdict**: ✅ Generated DDL matches architecture §3 for all four flagged items and for all column/constraint definitions. No drift.

> Note: this review lives in a separate file (not inline in `0000_init.sql`)
> because drizzle tracks the migration by content — editing the `.sql` would
> desync `meta/_journal.json` and `meta/0000_snapshot.json`.

## Four flagged items (research D1 "Verification duty")

| # | Item | §3 spec | Generated SQL (`0000_init.sql`) | Match |
|---|------|---------|----------------------------------|-------|
| 1 | `runs_one_active` partial **unique** index | `CREATE UNIQUE INDEX runs_one_active ON runs (ticket_id, agent_id) WHERE status IN ('queued','running','awaiting_human')` | line 135: `CREATE UNIQUE INDEX "runs_one_active" ON "runs" USING btree ("ticket_id","agent_id") WHERE status IN ('queued', 'running', 'awaiting_human')` | ✅ unique, columns + predicate identical (`USING btree` is the default, semantically inert) |
| 2 | `human_tasks_open` partial index (non-unique) | `CREATE INDEX human_tasks_open ON human_tasks (workspace_id, status) WHERE status = 'open'` | line 138: `CREATE INDEX "human_tasks_open" ON "human_tasks" USING btree ("workspace_id","status") WHERE status = 'open'` | ✅ non-unique, columns + predicate identical |
| 3 | `run_events.id` identity column | `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | line 88: `"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_events_id_seq" ...)` | ✅ bigint, GENERATED ALWAYS AS IDENTITY, primary key |
| 4 | `ON DELETE CASCADE` clauses | workspace→{executors,agents,tickets}; run→{run_checks,run_events}; all other FKs NO ACTION | lines 122–134: cascade on `executors/agents/tickets .workspace_id` and `run_checks/run_events .run_id`; `agents.executor_id`, `runs.*`, `human_tasks.*`, `webhook_events.workspace_id` = `ON DELETE no action` | ✅ exactly the §3 cascade set, nothing extra |

## Full-table spot check (all as-is)

- **workspaces** (10 cols): `jira_credentials "bytea" NOT NULL`, `jira_auth_type DEFAULT 'api_token'`, `settings jsonb DEFAULT '{}' NOT NULL`, `created_at/updated_at DEFAULT now()` — ✅. `"bytea"` (quoted) accepted by Postgres 16 at migrate time (harness.spec).
- **executors** (8): `config jsonb DEFAULT '{}'`, `secrets bytea` nullable, `concurrency_limit DEFAULT 2`, `UNIQUE(workspace_id,name)` — ✅
- **agents** (15): `status_success/status_failure NOT NULL`, `behavior jsonb DEFAULT '{}'`, `timeout_minutes DEFAULT 45`, `max_budget_usd numeric(8,2)`, `max_attempts DEFAULT 2`, `UNIQUE(workspace_id,name)` — ✅
- **tickets** (7): `UNIQUE(workspace_id,jira_key)`; `last_seen_*` present — ✅
- **runs** (19): full status set via `text DEFAULT 'queued'`, `attempt DEFAULT 1`, `cost_usd numeric(10,4)`, `runs_ticket` index on `(ticket_id, created_at DESC)` (line 136) — ✅
- **run_checks** (6): `run_id` cascade — ✅
- **human_tasks** (13): `blocking DEFAULT true`, `status DEFAULT 'open'` — ✅
- **webhook_events** (7): `UNIQUE(workspace_id,external_id)` — ✅

## Behavioral proof

`test/integration/db-constraints.spec.ts` — two concurrent INSERTs of an active run for the same `(ticket, agent)` → exactly one succeeds, the other raises Postgres `23505` (unique_violation); a terminal transition frees the guard for a new active run. Both assertions green.

## Deviations from architecture docs

None beyond the plan-level flags **F1/F2/F3** (none of which touch the schema). No new deviation introduced by the migration.

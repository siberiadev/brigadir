# Data Model: Pipeline Skeleton (001)

**Normative source**: `docs/architecture.md` §3 — implemented **as-is**; this
document adds only Drizzle-mapping notes, validation rules, and the run state
machine. Column lists are not re-copied where §3 is exhaustive; anything named
here that conflicts with §3 is a bug in this file.

## Tables (all 9, one migration set)

| Table | §3 highlights that must survive Drizzle codegen | Iteration-1 usage |
|---|---|---|
| `workspaces` | `jira_credentials bytea NOT NULL`; `settings jsonb DEFAULT '{}'`; `jira_auth_type DEFAULT 'api_token'` | 1 row seeded from agents.yaml; credentials = placeholder bytes |
| `executors` | `UNIQUE (workspace_id, name)`; `secrets bytea` nullable; `concurrency_limit DEFAULT 2`; FK cascade from workspace | seeded from yaml; type `mock` (research F1) |
| `agents` | `UNIQUE (workspace_id, name)`; FK `executor_id` (no cascade); `status_success`/`status_failure NOT NULL`; `behavior jsonb DEFAULT '{}'`; `max_attempts DEFAULT 2` | seeded from yaml; trigger fields present but unused (no ingest yet) |
| `tickets` | `UNIQUE (workspace_id, jira_key)`; `last_seen_status` is a cache (Constitution I) | test fixtures only |
| `runs` | full status enum incl. `superseded`; `attempt DEFAULT 1`; `trigger_event jsonb`; **`runs_one_active` partial unique index**; `runs_ticket` index | core of the iteration |
| `run_checks` | FK `run_id` cascade; `position`, `status` in pass/fail/skip/warn | written from mock reports |
| `run_events` | `bigint GENERATED ALWAYS AS IDENTITY` PK; `run_events_run (run_id, id)` index | timeline + rate_limited determinism marker |
| `human_tasks` | partial index `human_tasks_open ... WHERE status = 'open'`; `blocking DEFAULT true` | created by `needs_human` outcome |
| `webhook_events` | `UNIQUE (workspace_id, external_id)` | created empty; populated iteration 2 |

**Critical DDL that must appear verbatim in committed SQL** (review gate):

```sql
CREATE UNIQUE INDEX runs_one_active ON runs (ticket_id, agent_id)
  WHERE status IN ('queued', 'running', 'awaiting_human');
```

Statuses/enums are `text` columns constrained by application-level zod
validation (as §3 defines them — no Postgres ENUM types are introduced,
matching the schema as written).

## Run state machine (iteration-1 reachable subset)

```
                    ┌────────────── rate_limited (job re-queued,
                    ▼                attempt NOT consumed)
 queued ────────► running ──┬──► succeeded          (completed + success)
   ▲                        ├──► failed             (completed + failure |
   │  crashed & attempts    │                        crashed & attempts exhausted)
   └────────────────────────┤     timed_out         (timeout)
      (same row, attempt+1) ├──► awaiting_human     (completed + needs_human;
                            │                        + open human_task)
                            └──► cancelled          (cancelled — reachable via
                                                     API in later iterations)
```

- **Active** (blocks new run per partial index): `queued`, `running`, `awaiting_human`.
- **Terminal**: `succeeded`, `failed`, `timed_out`, `cancelled` (+ `superseded`, unreachable until human-task resume exists).
- **Invariants** (enforced in `RunsService`, tested):
  1. Terminal → any transition is refused (guarded UPDATE `WHERE status IN (active)`; 0 rows affected ⇒ log + skip).
  2. `attempt` only increases, only via the crashed-retry path.
  3. `awaiting_human` requires ≥ 1 linked open `human_tasks` row (created in the same transaction, dedup: skip if the run already has an open task).
  4. `finished_at` set exactly when entering a terminal state; `started_at` when first entering `running`.

## Relationships (unchanged from §3)

workspace 1—n executors, agents, tickets, runs, human_tasks, webhook_events;
executor 1—n agents; ticket 1—n runs; agent 1—n runs;
run 1—n run_checks, run_events, 0..n human_tasks.

## Validation rules (application layer, `packages/contracts`)

- `ReportSchema` v1 — as architecture §6 (`schema_version: 1`, outcome enum,
  checks ≤ 50, conditional: `outcome=needs_human` ⇒ `human_task` required).
- `AgentsConfigSchema` — yaml shape per docs/spec.md §0.1 + cross-refs
  (agent→executor exists; unique agent names) + `type: 'mock'` allowed.
- `trigger_event` (iteration 1): `{ source: 'manual', mock_scenario?: 'success'|'failure'|'needs_human'|'timeout'|'rate_limited'|'crash', rate_limit_ttl_ms?: number }`.
  Absent `mock_scenario` defaults to `success` (a real executor ignores the key entirely).

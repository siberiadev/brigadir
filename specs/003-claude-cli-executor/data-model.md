# Data Model — claude_cli Executor

**Result: NO schema change / NO migration.** (Confirms spec Key Entities note
and research D15.) Every value the executor produces maps to a column that
already exists in `libs/database/src/schema/runs.ts` and `run-events.ts`
(architecture §3). Below is the field-usage map that proves it.

## `runs` — columns written by this feature (all pre-existing)

| Column | Type | Written when | Source |
|---|---|---|---|
| `status` | text | markRunning / finalize | `RunsService` (unchanged) |
| `attempt` | int | markRunning | processor (BullMQ attempt) |
| `started_at` | tstz | markRunning | `RunsService` |
| `finished_at` | tstz | finalize | `RunsService` |
| `external_ref` | text | finalize | stream `session_id` (D13) |
| `worktree_path` | text | worktree prepared | `worktree.ts` (D3) |
| `exit_code` | int | finalize | child exit code |
| `cost_usd` | numeric(10,4) | finalize | result `total_cost_usd` (D11/D13) |
| `usage` | jsonb | finalize | result `usage` (D13) |
| `error` | text | failure finalize | stderr tail + validation/budget diagnostic (D13) |
| `report` | jsonb | finalize (success/failure/needs_human) | `structured_output`, zod-validated (D1) |
| `outcome` | text | finalize | report.outcome (via `finalizeWithReport`) |

`FinalizeExtra` (in `RunsService`) already carries `externalRef`, `costUsd`,
`usage`, `error`, `exitCode` — the processor passes them through. `worktree_path`
is set by the executor/processor on the run row when the worktree is prepared.

## `run_events` — rows written by this feature (all pre-existing types)

Existing `type` vocabulary: `progress | log | tool_call | api_retry | error |
jira_action`. The stream parser (D13) maps CLI events onto it:

| CLI stream event | `run_events.type` | `payload` |
|---|---|---|
| `system`/`init` | `log` | model, tools, mcp servers, session_id |
| assistant `tool_use` | `tool_call` | tool name + bounded input snippet |
| assistant text | `progress` | stage/message snippet (sampled, truncated) |
| `system`/`api_retry` (`rate_limit`) | `api_retry` | `{ error, retry_delay_ms, attempt }` |
| parser/exec diagnostics | `error` | bounded message |

No new event type, no new column.

## Entities (all existing — no new tables)

- **Run** — gains real values for the columns above; lifecycle owned by
  `RunsService` (unchanged state machine).
- **Run Event** — populated from the parsed stream, bounded/sampled.
- **Report** — `ReportSchema` (v1) unchanged; sole basis for a completed
  finalize.
- **Executor Configuration** — the only *shape* change, and it is in
  `packages/contracts` (zod), not the DB: a typed `claude_cli` branch on
  `ExecutorConfigSchema` (see `contracts/executor-config.md`).
- **Worktree** — on-disk artifact (`worktree_path` column references it), not a
  DB entity.

## Invariants preserved

- Terminal immutability: `guardedFinalize` stays `WHERE status IN (queued,
  running, awaiting_human)` — a late report or double-finalize hits 0 rows
  (spec edge cases; D1/D4/D12).
- `runs_one_active` partial unique index unchanged (Principle II).
- Reports validated against `ReportSchema` before persistence (Principle IV).

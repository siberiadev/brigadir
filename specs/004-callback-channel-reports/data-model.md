# Data Model: Callback Channel & Reports

**Migration verdict: NONE.** Every column this feature reads or writes already exists in
`docs/architecture.md` §3 and in the committed schema (`libs/database/src/schema/*`). Confirmed
against `runs.ts`, `human-tasks.ts`, `run-events.ts`, `run-checks.ts`. No `drizzle/` migration is
added. (Constitution rule 5: schema changes require an architecture doc update + SQL review — not
triggered here.)

---

## Persisted entities (existing tables — reused as-is)

### `runs` (architecture §3 — no change)
Feature 004 uses columns already present:

| Column | Use in this feature |
|---|---|
| `status` | State machine already includes `awaiting_human` and `superseded`. Callback flows drive: `running → awaiting_human` (blocking `request_human`), `running → succeeded/failed` (`complete_task`), `awaiting_human → superseded` (resume), `running → failed` (fail-closed, D7). |
| `attempt` | Resume inserts a new run with `attempt + 1` (FR-016). |
| `report` (jsonb) | `complete_task` report persisted here (via existing `RunsService.finalizeWithReport`). |
| `outcome` | `success \| failure \| needs_human` from the report. |
| `trigger_event` (jsonb) | Resume writes the human's answer + `source: 'human-resume'` here so the new attempt's wrapper can inject it (FR-018). |
| `external_ref`, `worktree_path`, `error`, `started_at`, `finished_at` | Unchanged from iteration 3. |
| `cost_usd`, `usage` | **Revised post-004 (cost regression fix):** for callback-wired runs the `complete_task` finalize precedes the CLI process exit, so the terminal event's `total_cost_usd`/`usage` only become known when every status-guarded write is already a no-op. The processor now persists them via `RunsService.recordCostUsage` — a status-independent, best-effort (never-throws) UPDATE by run id issued after the executor settles, on every exit path. Overwrite semantics: the last CLI session that emitted a result event wins. |

**Invariants preserved:** `runs_one_active` partial unique index `(ticket_id, agent_id) WHERE status
IN ('queued','running','awaiting_human')` (idempotency level 3). Resume MUST supersede the old run
**before/within the same transaction** as inserting the new attempt, else the index raises `23505`
(FR-016 single-transaction requirement). Guarded terminal UPDATEs remain the completion mechanism
(FR-009 idempotency; 409 on repeat).

### `run_checks` (architecture §3 — no change)
Per-check rows written by `RunsService.writeChecks` from `report.checks` (name / status ∈
`pass|fail|skip|warn` / reason). Already implemented; drives the Jira ADF checklist + dashboard.

### `run_events` (architecture §3 — no change)
Timeline. This feature adds **event payloads**, not columns. Types used:
- `progress` — from `report_progress` (stage, message, percent). Also `job.updateProgress()` + SSE.
- `tool_call` — optional record of a callback tool invocation.
- `error` — callback validation failures / transient retries (diagnostic trail).
- `jira_action` — existing marker written by `PipelineService.onRunFinished` (unchanged).

SC-006 (ordered inspectable timeline) is satisfied by the existing `run_events_run (run_id, id)`
index.

### `human_tasks` (architecture §3 — no change)
All columns already present and sufficient:

| Column | Use |
|---|---|
| `kind` | `question \| blocker \| review` (matches `HUMAN_TASK_KINDS`). |
| `title`, `details` | From `request_human` / report `human_task` — **scrubbed** before insert (FR-024). |
| `blocking` | `true` parks the run (`awaiting_human`); `false` leaves it running (FR-012/FR-014). |
| `status` | `open → resolved \| dismissed`. |
| `resolution` | The human's answer; read on resume to seed the new attempt's context (FR-018). |
| `resolved_at`, `resolved_by` | Set on resolve. |
| `run_id`, `ticket_id`, `workspace_id` | Associations (FR-015). |

**Dedup invariant (FR-020):** at most one **open** `human_task` per run from the completion path —
already enforced by `RunsService.createHumanTask` (`WHERE run_id = … AND status = 'open'` guard).
The `request_human` callback path reuses the same dedup guard.

---

## Ephemeral / non-persisted entities (NEW — not in the DB)

### Per-run credential (Run JWT)
Signed HS256 token, **never stored**. Claims `{ sub: runId, wsp: workspaceId, tkt: ticketKey, iat,
exp = started_at + timeout + grace }`. Minted by the worker; verified by the callback guard; the DB
run `status` is the authorization source of truth (FR-003). Contract: `contracts/run-jwt.md`.

### mcp-config file
Per-run `0600` JSON file (outside the worktree), server `env` block carries the **literal** run token
+ callback URL + run id + marker path. Deleted at run cleanup. Contract: `contracts/mcp-config.md`.

### Completion marker
Per-run file written by `brigadir-mcp` after a successful `complete_task` / blocking `request_human`;
read by the Stop hook (FR-013). Path passed to both via env / hook command. Not persisted.

### Stop-hook settings
Inline JSON passed to `claude --settings`, registering one `Stop` hook. Contract:
`contracts/stop-hook-settings.md`.

---

## State transitions (run lifecycle — this feature's edges)

```
running ──complete_task(success)──────────────► succeeded      (FR-007)
running ──complete_task(failure)──────────────► failed         (FR-007)
running ──complete_task(needs_human)──────────► awaiting_human  + open human_task (FR-007, FR-020)
running ──request_human(blocking=true)────────► awaiting_human  + open human_task + Jira Blocked (FR-012)
running ──request_human(blocking=false)───────► running         + open human_task (non-blocking) (FR-014)
running ──report_progress─────────────────────► running         + run_events (FR-021)
running ──process exits, no callback──────────► failed          (fail-closed, guard status='running') (FR-010/D7)
awaiting_human ──resolve(resume)──────────────► superseded ; NEW run attempt+1 (queued) in one tx (FR-016)
awaiting_human ──resolve(done_manually|dismiss)► (task resolved/dismissed; run stays closed, no new attempt, no auto-transition) (FR-019)
<any terminal> ──late/duplicate callback──────► 409, no state change (FR-009, SC-004/007)
```

**Guards (all preserved):** every terminal write is `WHERE status ∈ active`; the fail-closed write is
tightened to `WHERE status = 'running'` (D7) so it cannot clobber `awaiting_human`. The callback guard
rejects (401/409) any token whose `sub ≠ :runId`, is expired, or whose run is not in
`{running, awaiting_human}` (FR-003; SC-004).

---

## Validation rules (from requirements)

- `complete_task` body MUST satisfy `ReportSchema` (`schema_version=1`, `outcome`, `summary`,
  `checks`); `outcome=needs_human ⇒ human_task` (existing `superRefine`). Failure → machine-readable
  zod `issues` list, run **not** finalized (FR-008; SC-...).
- `request_human` body MUST satisfy `RequestHumanSchema` (kind, title ≤120, details ≤4000, blocking).
- `report_progress` body MUST satisfy `ReportProgressSchema` (stage, message ≤500, percent 0–100?).
- All agent free-text fields pass the **secret scrubber** before persist and before any Jira write
  (FR-024; SC-005).

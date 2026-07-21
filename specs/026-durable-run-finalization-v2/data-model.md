# Data Model: Durable Run Finalization v2

**No database schema changes.** `docs/architecture.md` §3 stays as-is.
All new persistence rides on existing structures: `run_events` rows
(free-text `type` column) and on-disk outbox files.

## Entities

### Outbox report file (on disk — existing, contract widened)

Path: `<defaultMcpConfigRoot(os.tmpdir())>/.brigadir-outbox/<runId>.json`

| Field | Type | Notes |
|-------|------|-------|
| `runId` | uuid string | Must equal the filename stem AND the reader's expected run id (mismatch ⇒ treated as unresolvable) |
| `outcome` | string | Advisory copy, read defensively by the writer; the authoritative outcome comes from `report` after `ReportSchema.parse` |
| `report` | object | Raw `complete_task` tool args; validated only by `finalizeWithReport` / reconcile paths via `ReportSchema.parse` |
| `timestamp` | ISO string | Written by the tool server; informational |

Lifecycle: written by `packages/mcp-server/src/outbox.ts` before every
`complete_task` HTTP POST; deleted by the writer on 2xx; otherwise
consumed (deleted) by exactly one reader path (exit-time reconcile,
periodic reconciler) or aged out by retention. File mtime drives the
7-day retention for unresolvable files. Directory lifetime is decoupled
from per-run cleanup (Clarification Q5).

### Run (existing table `runs` — no change; relevant fields)

| Field | Role in this feature |
|-------|----------------------|
| `status` | Decision key for the resolution matrix (below) |
| `outcome` | `NULL` on every non-report finalize — the marker of a "terminal-bad, rescue-eligible" run (`failed`/`timed_out` + `outcome IS NULL`) |
| `attempt` | Must NOT increase on guard-fail? — it does not: guard fails finalize the run; probe holds happen before `markRunning`, so `attempt` is untouched |
| `report`, `error` | Written by `finalizeWithReport` / fail-closed paths exactly as today |

### Run event: `undelivered_report` (new type value)

One per run (deduped by existence check before insert).

```jsonc
{
  "type": "undelivered_report",
  "payload": {
    "report": { /* schema-valid, scrubbed AgentReport */ },
    "run_status": "cancelled",           // status at attach time: cancelled | superseded
    "source": "exit_reconcile"           // exit_reconcile | periodic_reconcile
  }
}
```

Invariants: only schema-valid reports are attached (invalid files never
reach the DB); payload passes `scrubAgentReport` before insert
(Constitution V); insertion never changes `runs.status`.

### Run event: `channel_down` (new type value)

Zero or more per run (one per failed probe; failures are spaced by the
hold TTL, ≥30 s apart).

```jsonc
{
  "type": "channel_down",
  "payload": {
    "probe_url": "http://127.0.0.1:3000/api/callbacks/health",
    "consecutive": 2,                    // 1-based consecutive failure count
    "retry_in_ms": 60000                 // hold TTL chosen for this failure
  }
}
```

Invariants: written only for callback-wired runs, only before
`markRunning` (run is `queued`); contains no secrets (URL is operator
config, not credential-bearing).

## State/decision matrices

### Periodic reconciler resolution matrix (FR-008, D6)

| Run state at scan | Action | File |
|---|---|---|
| `running` | scrub + `finalizeWithReport`; on flip → `onRunFinished` | consume |
| `failed` / `timed_out`, `outcome IS NULL` | same as above | consume |
| `failed` / `timed_out`, `outcome NOT NULL` | nothing (already report-finalized) | consume + log |
| `succeeded` / `awaiting_human`→resumed→terminal etc. (any terminal with outcome) | nothing | consume + log |
| `cancelled` / `superseded` | attach `undelivered_report` (deduped) | consume |
| `awaiting_human` | **skip** — live human completion path | **keep** |
| `queued` | skip (run not yet executed this attempt; a stale file here means a prior attempt's report — rare; next terminal state resolves it) | keep |
| unknown run id | nothing | consume + log |
| unparseable JSON / `runId` mismatch / schema-invalid report | warn once per worker lifetime | keep; delete when mtime > 7 days |

`finalizeWithReport` returning `flipped=false` in the first two rows ⇒ a
concurrent finalizer won; treat as "already finalized": consume, no event.

### Exit-time branch mapping (FR-004/005/006, D4)

| Exit decision (callback-wired) | Outbox present & valid | Outbox present & invalid | No outbox |
|---|---|---|---|
| `completed` (run still `running`) | scrub + finalize; flip → consume + afterFinalize; no-flip → consume, done | fail-closed (`failIfStillRunning`), keep file | fail-closed (unchanged) |
| `timed_out` | existing reconcile + NEW scrub step | fall through to `timed_out` finalize, keep file | `timed_out` finalize (unchanged) |
| `cancelled` | attach `undelivered_report` + consume, then guarded `cancelled` finalize (unchanged) | keep file, guarded finalize | unchanged |
| `rate_limit` (park, non-terminal) | untouched (run still live; periodic reconciler covers) | untouched | unchanged |
| `retry` | untouched | untouched | unchanged |

### Artifact guard verdict (FR-001/002, D1/D2)

| Condition | Verdict | Startup effect | Pickup effect (callback-wired only) |
|---|---|---|---|
| entry missing | `missing` | error banner, worker starts | run → `failed` with explicit error |
| `mtime(entry) < max(mtime(src/**))` | `stale` (banner includes both timestamps) | error banner | run → `failed` with explicit error |
| src dir absent | pass (`skipped: no-src-dir`, debug log) | none | none |
| fresh | pass | none | none |

Memoized 10 s; re-evaluated per pickup ⇒ a rebuild heals without worker
restart. Phase-0 runs: guard never evaluated on their path.

### Pre-flight hold (FR-012–014, D8)

| Probe result | Counter | Hold TTL | Events/logs |
|---|---|---|---|
| 2xx | reset to 0 | — (proceed) | — |
| failure #1 | 1 | 30 s | `channel_down` event, warn log |
| failure #2 | 2 | 60 s | `channel_down` event, warn log |
| failure #N≥3 | N | min(30 s·2^(N−1), 5 min) | `channel_down` event, **error** log (alert threshold, Clarification Q3) |

Run row stays `queued` throughout; `attempt` never increments (hold is
before `markRunning`, mirroring the executor-gate precedent).

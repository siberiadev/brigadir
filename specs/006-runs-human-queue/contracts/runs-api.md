# Contract — Runs API (US2 card, US3 table)

All routes are guarded by `DashboardTokenGuard` (shared bearer, feature 005). Error shape is
the shared path-qualified envelope from `contracts/dashboard-api.md` (005):
`{ error: { code, message, issues[], warnings[] } }`. Response bodies use `snake_case`
(matches the feature-005 dashboard convention and the `apiClient`/msw handlers).

Types live in `packages/contracts/src/runs.schema.ts` (new) — single typed source consumed by
the backend controller and the Vue composables.

---

## GET `/api/workspaces/:id/runs` — runs table (FR-015, FR-016)

Query params (all optional):
- `agent` — agent id filter
- `status` — run status filter (one of the run status vocabulary)
- `ticket` — case-insensitive substring on `tickets.jira_key`
- `page` (default 1), `page_size` (default 25, max 100)

**200** →
```jsonc
{
  "items": [
    {
      "run_id": "uuid",
      "agent": { "id": "uuid", "name": "reviewer" },
      "ticket": { "key": "BRIG-42", "summary": "Fix login", "jira_url": "https://acme.atlassian.net/browse/BRIG-42" },
      "status": "running",
      "attempt": 2,
      "duration_ms": 18234,          // finished−started; running → now−started; null if not started
      "cost_usd": "0.0412",          // numeric as string; null if absent
      "created_at": "2026-07-12T10:00:00.000Z"
    }
  ],
  "page": 1,
  "page_size": 25,
  "total": 137                       // total of the FILTERED set (FR-016 pagination reflects filter)
}
```
Ordered `created_at desc`. Empty workspace → `items: []` (empty state, not an error —
spec Edge Case).

## GET `/api/workspaces/:id/runs/cost` — lite cost figure (FR-019, SC-010)

Query: `period` ∈ `24h | 7d | 30d` (default `7d`).

**200** → `{ "period": "7d", "total_cost_usd": "3.9120", "run_count": 88 }`

---

## GET `/api/runs/:id` — run/ticket card (FR-007..FR-011)

**200** →
```jsonc
{
  "run": {
    "run_id": "uuid",
    "status": "failed",
    "attempt": 1,
    "executor_type": "claude_cli",
    "agent": { "id": "uuid", "name": "reviewer" },
    "duration_ms": 42000,
    "cost_usd": "0.11",
    "usage": { /* jsonb passthrough, optional */ },
    "outcome": "failure",
    "external_ref": "sess_abc",       // optional deep link target (spec Edge Case)
    "error": "…stderr/diagnostics…",  // FR-011 (present for failed runs)
    "created_at": "…", "started_at": "…", "finished_at": "…"
  },
  "ticket": { "key": "BRIG-42", "summary": "Fix login", "jira_url": "https://acme.atlassian.net/browse/BRIG-42" },
  "checks": [                          // FR-008, ordered by position; may be []
    { "position": 0, "name": "tests pass", "status": "fail", "reason": "2 failing in auth.spec" }
  ],
  "events": [                          // FR-010, chronological by id; may be []
    { "id": "1024", "type": "tool_call", "payload": { /* jsonb */ }, "created_at": "…" }
  ],
  "history": [                          // FR-009 — all runs for this ticket, newest first
    { "run_id": "uuid", "agent": "reviewer", "executor_type": "claude_cli", "attempt": 1,
      "duration_ms": 42000, "cost_usd": "0.11", "outcome": "failure", "status": "failed" }
  ]
}
```
- `checks[].status` ∈ `pass|fail|warn|skip` → UI ✅/❌/⚠/⏭.
- Missing summary / null cost render gracefully; a report with no checks → `checks: []`
  (spec Edge Cases "partial report", "deep links").
- **404** `{ error: { code: "run_not_found" } }` when the id is unknown.

---

## POST `/api/runs/:id/cancel` — cancel a running run (FR-012)

Body: none. Server performs the **guarded** flip:
`UPDATE runs SET status='cancelled' WHERE id=:id AND status='running'` (rows-affected gate).
The worker's existing cancel poll (`isStillActive` → `status==='running'`) then aborts the
process and the executor finalizes.

- **200** `{ "ok": true, "cancelled": true }` when a row flipped.
- **200** `{ "ok": true, "cancelled": false, "reason": "not_running" }` when 0 rows (already
  terminal, or `awaiting_human` — MUST NOT be overwritten, constitution rule #7 / spec Edge
  Case "Cancel race").
- **404** unknown id.

## POST `/api/runs/:id/retry` — retry a finished run (FR-013)

Reuses the existing manual-trigger path: resolves the run's `(ticket_id, agent_id)` and calls
`RunTriggerService.trigger({ ticketId, agentId })` (same as `agents.controller` test-run) —
all three idempotency layers apply.

- **200** `{ "ok": true, "run_id": "<new uuid>", "deduplicated": false }`.
- **409** `{ error: { code: "active_run_exists" } }` when `runs_one_active` would reject a
  second active run (spec Edge Case "Retry semantics") — surfaced cleanly, not a 500.
- **404** unknown id.

---

## Live updates
No streaming endpoints. The runs table, card, cost figure, and history are refreshed by the
client via TanStack Query `refetchInterval` (research R1): ~4–5 s for the focused table,
~3 s for an **open** run card; terminal cards do not poll. Every refetch is an ordinary
bearer-authenticated GET — no token in any URL (FR-031).

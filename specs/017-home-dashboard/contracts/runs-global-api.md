# Contract — Global (cross-workspace) runs listing (US3, US4)

Guarded by `DashboardTokenGuard`. Lives in the existing `RunsController`
(`apps/backend/src/dashboard/runs.controller.ts`, bare `@Controller()`), route `@Get('api/runs')` —
composes with the existing `GET /api/runs/:id` run card. Types in
`packages/contracts/src/home.schema.ts`.

**Bounded by contract**: `status` is REQUIRED and `limit` is always capped — an unbounded
"all runs everywhere" query is impossible (FR-014).

---

## GET `/api/runs`

Query:

| Param | Rule |
|---|---|
| `status` | **REQUIRED.** Comma-separated, each value ∈ `RunStatusSchema` (`queued\|running\|awaiting_human\|succeeded\|failed\|cancelled\|timed_out\|superseded`). Missing, empty, or any unknown token → **422** `validation_error`. |
| `finished_within` | Optional ∈ `24h\|7d\|30d` (reuses `RunCostPeriodSchema`). Adds `finished_at >= now() - interval`. |
| `limit` | Optional int. Default **10**, bounded to **1..50**; garbage or out-of-range input falls back to the default (the pagination `.catch()` convention — never a 500). |

Home usage: needs-attention → `?status=failed,timed_out&finished_within=24h&limit=10`;
live runs → `?status=running,queued&limit=10`.

**200** →
```jsonc
{
  "items": [
    {
      "run_id": "uuid",
      "status": "running",
      "attempt": 1,
      "agent": { "id": "uuid", "name": "Hera", "key": "hera-reviewer", "role": "Reviewer" }, // role nullable
      "ticket": { "key": "PAY-151", "summary": "…", "jira_url": "https://…/browse/PAY-151" }, // reuses RunTicketRefSchema; null for ticketless setup runs
      "workspace": { "id": "uuid", "name": "Payments Core" },   // the new cross-workspace dimension
      "started_at": "2026-07-17T08:01:00Z",   // nullable — ticker anchor
      "finished_at": null,                     // nullable — needs-attention finish time
      "duration_ms": null,                     // finished − started, nullable
      "cost_usd": null,                        // string | null
      "created_at": "2026-07-17T08:00:58Z"
    }
  ],
  "total": 5      // FULL count matching the filter (not items.length) — powers "view all (N)"
}
```

Envelope is `{ items, total }` — **deliberately NOT** `makePaginatedResponseSchema` (dashboard
top-N consumer, FR-025; no `page`/`page_size`).

Joins mirror the workspace-scoped list: LEFT JOIN `tickets` (ticketless workspace-setup runs
MUST appear), INNER JOIN `agents`, INNER JOIN `workspaces` (name + `jira_site_url` for
`deep_link`).

---

## Deterministic ordering (fixed, no `order` param)

1. Status rank: `running` → 0, `queued` → 1, anything else → 2.
2. Within rank 0: `started_at ASC NULLS LAST` (longest-running first).
3. Within rank 1: `created_at ASC` (longest-waiting first).
4. Within rank 2: `finished_at DESC NULLS LAST` (most recently finished first).
5. Final tie-break: `id ASC`.

Implemented as a single SQL `ORDER BY` with CASE expressions; deterministic for any status
combination (satisfies the mandatory-ORDER BY convention).

---

## Errors

- **401** — missing/wrong bearer (class guard).
- **422** `validation_error` — `status` missing/empty/unknown token, or `finished_within` not in
  the enum. Uses the shared `dashboard.errors.ts` helpers. (`limit` never errors — clamped.)

## Non-goals

- No pagination (use workspace-scoped `GET /api/workspaces/:id/runs` for browsing history).
- No free-text/ticket filter, no `agent`/`source` filters (workspace-scoped list keeps those).
- Existing `GET /api/workspaces/:id/runs`, `GET /api/runs/:id` are **unchanged**.

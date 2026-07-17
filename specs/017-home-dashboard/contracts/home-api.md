# Contract — Home aggregate API (US2, US5, US6)

Guarded by `DashboardTokenGuard`. `snake_case` bodies, `.strict()` schemas. Types in
`packages/contracts/src/home.schema.ts` (new), exported via the contracts barrel. New
`HomeController` (`@Controller('api/home')`) in `apps/backend/src/dashboard/`, registered in
`DashboardModule`. Read-only: GET only, no writes. **No DB schema changes.**

---

## GET `/api/home/summary` (FR-009..FR-011, FR-021..FR-022)

No query params (spend for all periods is always included; the period switcher is client-side).

**200** →
```jsonc
{
  "running": 3,                       // COUNT runs WHERE status='running' (all workspaces)
  "queued": 2,                        // COUNT runs WHERE status='queued'
  "attention_24h": {                  // finished_at >= now() - 24h
    "failed": 1,
    "timed_out": 1
  },
  "human_open": 3,                    // COUNT human_tasks WHERE status='open'
                                      // (same predicate as GET /api/human-tasks/count)
  "spend": {                          // window on created_at — MUST match the per-workspace
    "24h": { "total_cost_usd": "18.4200", "run_count": 37 },   // cost endpoint so platform
    "7d":  { "total_cost_usd": "96.1000", "run_count": 214 },  // total == Σ workspace totals
    "30d": { "total_cost_usd": "342.7700", "run_count": 861 }  // (SC-004)
  }
}
```

- `total_cost_usd` is a **string** (`COALESCE(SUM(cost_usd),0)::text`, numeric round-trip —
  same convention as `RunCostResponseSchema`). Zero spend → `"0"`-style string, never null.
- All counters are plain `int ≥ 0`; an idle platform returns all zeros with **200** (never 404).
- One atomic response: all four tile counters + spend come from the same request (FR-010).
- **401** without/with wrong bearer token (guard), like every dashboard route.

**Schema**: `HomeSummaryResponseSchema` / type `HomeSummaryResponse`.

---

## GET `/api/home/workspaces` (FR-018..FR-020)

No query params. Returns ALL workspaces (dashboard whole-list consumer — no pagination
envelope), ordered `created_at ASC` (same as the existing workspaces list). Item count for this
internal tool is small by construction.

**200** →
```jsonc
{
  "items": [
    {
      "id": "uuid",
      "name": "Payments Core",
      "project_key": "PAY",             // workspaces.jira_project_key (card board chip)
      "board_type": "kanban",           // nullable
      "enabled": true,                  // settings.enabled !== false; false ⇒ card renders paused
      "agent_count": 4,                 // COUNT agents in workspace (incl. orchestrator)
      "last_run": {                     // newest by created_at, or null ⇒ "no runs yet"
        "run_id": "uuid",
        "status": "running",            // RunStatus enum — rendered via RunStatusTag
        "started_at": "2026-07-17T08:01:00Z",   // nullable
        "finished_at": null,                     // nullable
        "created_at": "2026-07-17T08:00:58Z"
      },
      "attention_24h": 1                // failed+timed_out runs, finished_at >= now()-24h
    }
  ]
}
```

- Implementation: ≤4 batched queries (workspaces, agent counts GROUP BY, last runs via
  `DISTINCT ON (workspace_id) ... ORDER BY workspace_id, created_at DESC` on the existing
  `runs_workspace_created` index, attention counts GROUP BY) merged in memory.
  **Request-per-workspace patterns are forbidden** (FR-020) — this endpoint exists so the
  browser makes exactly one call for the grid.
- Zero workspaces → `{ "items": [] }`, **200**.
- The existing `GET /api/workspaces` (paginated, settings-heavy) is **unchanged**.

**Schemas**: `HomeWorkspaceItemSchema`, `HomeWorkspacesResponseSchema`.

---

## Consistency invariants (tested)

- `summary.running` / `summary.queued` equal the `total` of `GET /api/runs?status=running` /
  `?status=queued` at the same instant.
- `summary.attention_24h.failed + .timed_out` equals the `total` of
  `GET /api/runs?status=failed,timed_out&finished_within=24h`.
- `summary.spend[P].total_cost_usd` equals the sum over workspaces of
  `GET /api/workspaces/:id/runs/cost?period=P` (string-decimal comparison).
- `summary.human_open` equals `GET /api/human-tasks/count` → `open`.
- Boundary: a run with `finished_at` exactly 25h old is excluded from every 24h figure; a
  null-cost run counts in `run_count` but adds 0 to `total_cost_usd`.

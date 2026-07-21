# Contract: Channel Health API (additive)

## GET /api/channel-health

- **Auth**: `DashboardTokenGuard` (Bearer `BRIGADIR_DASHBOARD_TOKEN`) — same
  surface as every dashboard endpoint. NOT the run-token guard; NOT public.
- **Method/params**: GET, no query params (window/threshold are server
  config; the response echoes the effective values).
- **Response 200** — `ChannelHealthResponseSchema`
  (`packages/contracts/src/channel.schema.ts`, strict):

```json
{
  "status": "degraded",
  "generated_at": "2026-07-21T17:20:00.000Z",
  "window_ms": 900000,
  "failure_threshold": 3,
  "last_successful_callback_at": "2026-07-21T17:04:12.345Z",
  "channel_failures_in_window": 4,
  "probe_failures_in_window": 1,
  "deployment_guard": { "ok": true, "reason": null },
  "affected_runs": [
    {
      "run_id": "3f60c1a1-….",
      "ticket_key": "BRG-42",
      "last_event_at": "2026-07-21T17:18:03.000Z"
    }
  ]
}
```

- `status` rule: `degraded` ⇔ `probe_failures_in_window >= 1` OR
  `channel_failures_in_window >= failure_threshold` OR
  `deployment_guard.ok === false`; else `healthy`. Fresh system ⇒
  `healthy` with `last_successful_callback_at: null`, zero counts.
- `affected_runs`: distinct runs having `channel_failure` /
  `undelivered_report` / `channel_down` events within the window, newest
  first, hard cap 20 (cap is part of the contract; the UI states "top 20"
  when at cap).
- Errors: 401 (bad/missing dashboard token) only. The endpoint never 500s on
  guard-file absence (guard verdict `{ok:false, reason:'missing'}` is data,
  not an error).
- Derivation is read-only over existing data (`run_events`, artifact mtimes);
  the endpoint creates no state and is safe at 5 s polling.

## Runs list: additive field

`GET /api/workspaces/:id/runs` items (`RunListItemSchema`, strict) gain:

| field | type | semantics |
|---|---|---|
| `callback_alert` | boolean | `EXISTS (run_events WHERE run_id = run.id AND type IN ('undelivered_report','channel_failure'))` — per-run, not windowed |

No other list/detail response changes. Run detail (`GET /api/runs/:id`)
is untouched — `events[]` already carries the underlying rows, including the
new `channel_failure` type (typed loosely by `RunCardEventSchema`).

## Explicit non-changes

- `POST /api/callbacks/runs/:runId/{progress,human,complete}` — untouched.
- `GET /api/callbacks/health` — untouched (remains the probe's target).
- `GET /health` — untouched (infra liveness, unauthenticated).
- No new tables, no migrations, no changes to `ReportSchema` or callback
  tool schemas.

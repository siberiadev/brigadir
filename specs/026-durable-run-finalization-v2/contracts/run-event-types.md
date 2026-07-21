# Contract: New run_event types

`run_events.type` is a free-text column (`libs/database/src/schema/run-events.ts`)
— adding values is contract-additive, no migration. The documented set in
the schema comment and the dashboard presenter's `KNOWN_TYPES`
(`apps/web/src/components/RunTimeline/presenter.ts`) are updated in the
same change. Older dashboards render unknown types via the existing
generic fallback — no forced lockstep deploy.

## `undelivered_report`

Emitted by: exit-time reconcile (`cancelled` branch) and periodic
reconciler (`cancelled`/`superseded` rows). At most one per run
(pre-insert existence check).

```jsonc
{
  "type": "undelivered_report",
  "payload": {
    "report": { /* AgentReport — schema-valid, passed scrubAgentReport */ },
    "run_status": "cancelled",        // "cancelled" | "superseded"
    "source": "exit_reconcile"        // "exit_reconcile" | "periodic_reconcile"
  }
}
```

Guarantees: never accompanies a status change; payload.report always
parses against the versioned `ReportSchema`; all free-text fields
scrubbed (Constitution V).

Dashboard: timeline card titled «Недоставленный отчёт» showing
`report.outcome`, first line of `report.summary`, and the source; full
payload behind the existing payload expander.

## `channel_down`

Emitted by: pre-flight channel probe, one row per failed probe attempt
(spaced ≥30 s by the hold TTL). Run is `queued` at emission time.

```jsonc
{
  "type": "channel_down",
  "payload": {
    "probe_url": "http://127.0.0.1:3000/api/callbacks/health",
    "consecutive": 3,                 // 1-based; >=3 ⇒ alert threshold reached
    "retry_in_ms": 120000             // hold TTL applied after this failure
  }
}
```

Guarantees: no secrets (URL is deploy config); never emitted for Phase-0
runs; emission never changes run status or attempt count.

Dashboard: timeline card titled «Канал недоступен» with consecutive count
and retry-in; `consecutive >= 3` may render with the error accent.

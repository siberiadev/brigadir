# Data Model: Callback-Channel Resilience Ops (027)

**No database schema changes.** All persistence reuses `run_events`
(`libs/database/src/schema/run-events.ts`: `id` identity PK, `run_id` uuid FK
cascade, `type` text, `payload` jsonb, `created_at` timestamptz, index
`(run_id, id)`). New artifacts are: one filesystem transit format, one new
`run_events.type` value, one payload enrichment, one additive API response
schema, one additive list field, one Redis key pair, and new env config.

## 1. Channel-failure breadcrumb (filesystem transit record)

**Location**: `<configRoot>/.brigadir-channel/<runId>.jsonl` — one JSON object
per line, append-only. `configRoot` = `dirname(BRIGADIR_MARKER_PATH)` on the
writer side ≡ `resolveMcpConfigRoot()` on the reader side (the 026 outbox
convention). Lifecycle: created by mcp-server on first retry exhaustion;
claimed by rename to `<runId>.jsonl.ingesting`; deleted after ingestion.
Bound: writer skips appends once file > 64 KB.

**Record** (zod `ChannelBreadcrumbRecordSchema` in
`packages/contracts/src/channel.schema.ts`; enforced by the reader, matched
by writer tests):

| field | type | notes |
|---|---|---|
| `ts` | ISO string | when delivery gave up (writer clock) |
| `tool` | `'report_progress' \| 'request_human' \| 'complete_task' \| string` | callback tool name; free string tolerated for future tools |
| `kind` | `'network' \| 'http'` | which retry budget exhausted (network throw vs 5xx) |
| `attempts` | int ≥ 1 | total attempts incl. first (network: 11, http: 4 at defaults) |
| `error` | `{ name: string, message: string }` | last error; message scrubbed on ingestion |
| `status` | int, optional | last HTTP status (kind='http' only) |
| `target` | string | host:port only — never path/query/headers |

**Validation**: reader parses per line; invalid lines are dropped with a
warn-once log (file still consumed). `runId` comes from the filename stem and
must match `UUID_RE` (same rule as the outbox reconciler).

## 2. `channel_failure` run-event (new `run_events.type` value)

One row per breadcrumb record, inserted by the worker (never the mcp-server —
it has no DB access). Constant `CHANNEL_FAILURE_EVENT = 'channel_failure'`
alongside `CHANNEL_DOWN_EVENT` / `UNDELIVERED_REPORT_EVENT`.

**Payload** (`ChannelFailureEventPayloadSchema`): the breadcrumb record fields
plus:

| field | type | notes |
|---|---|---|
| `occurred_at` | ISO string | = breadcrumb `ts`; timeline displays this, not `created_at` (ingestion lag ≤ reconcile cadence) |
| `source` | `'exit' \| 'reconcile'` | which ingestion path won the claim (mirrors 026's `exit_reconcile`/`periodic_reconcile` convention) |

**State rules**: ingestion never writes `runs.status`/`outcome`; rows may be
attached to already-finalized runs (late diagnostics). Distinct from
`channel_down` (pre-flight probe failure, worker-side witness, payload
`{probe_url, consecutive, retry_in_ms}`) — both count toward health, only
`channel_failure` marks a specific run's delivery loss.

**Idempotency**: guaranteed by the filesystem claim (atomic rename), not by
DB constraints — exactly one ingestion pass per file; no duplicate-row hazard
between the exit path and the reconciler.

## 3. `progress` event payload enrichment (additive)

Live callback progress inserts (`libs/callback/src/callback.service.ts:62`)
gain `via: 'callback'` in the payload. Purpose: distinguish backend-received
callbacks from executor-observed stream duplicates (`stream-parser.ts:204`)
so `last_successful_callback_at` can be derived. Additive-only: timeline
presenter ignores unknown keys; old rows without the tag are simply not
counted.

## 4. Channel health aggregate (derived, never stored)

`ChannelHealthResponseSchema` (`packages/contracts/src/channel.schema.ts`),
returned by `GET /api/channel-health`:

| field | type | derivation |
|---|---|---|
| `status` | `'healthy' \| 'degraded'` | degraded ⇔ `probe_failures_in_window ≥ 1` OR `channel_failures_in_window ≥ threshold` OR `!deployment_guard.ok` |
| `generated_at` | ISO string | `now()` at aggregation |
| `window_ms` | int | effective window (default 900 000) |
| `last_successful_callback_at` | ISO string \| null | `max(created_at)` of `run_events` `type='progress' AND payload->>'via'='callback'`; null until first tagged event |
| `channel_failures_in_window` | int | count `type='channel_failure' AND created_at > now()-window` |
| `probe_failures_in_window` | int | count `type='channel_down' AND created_at > now()-window` |
| `deployment_guard` | `{ ok: boolean, reason: 'missing' \| 'stale' \| null }` | memoized `checkMcpServerArtifact()` run in-process by the backend (shared host filesystem) |
| `affected_runs` | `Array<{ run_id, ticket_key: string \| null, last_event_at }>` max 20 | distinct runs with `channel_failure`/`undelivered_report`/`channel_down` events in window, newest first |

State transitions: none persisted — healthy/degraded is recomputed per
request; auto-recovery is the window sliding past the last failure row.

## 5. Runs list projection (additive contract field)

`RunListItemSchema` (strict) gains `callback_alert: z.boolean()` — projected
by the workspace runs list query as
`EXISTS (run_events WHERE run_id = runs.id AND type IN
('undelivered_report','channel_failure'))`. Not windowed — a run that ever
lost callbacks keeps its marker (it is a per-run fact, unlike the global
windowed health). Run detail needs no new field: the card's `events[]`
already carries the rows.

## 6. Worker lock (Redis, transient)

| key | value | semantics |
|---|---|---|
| `${BULLMQ_PREFIX ?? 'bull'}:worker-lock` | JSON `{ mode, pid, hostname, acquired_at }` | `SET NX PX ttl`; renewal (compare-and-extend Lua) every ttl/3; release = compare-and-del on shutdown; TTL expiry = bounded takeover |
| `${prefix}:worker-lock:contender` | same identity shape, TTL 30 s | written by a blocked contender so the HOLDER can also log the conflict (loud on both sides) |

`mode` from `BRIGADIR_WORKER_MODE` (`'dev'` default, `'agents'` in stable
mode). All WorkerHost queue consumers are paused unless the lock is held;
renewal loss ⇒ immediate re-pause + re-acquire loop. Never durable state:
holds no run/queue data.

## 7. Configuration surface (all lazy-read, documented in `.env.example`)

| env | default | consumer |
|---|---|---|
| `BRIGADIR_AGENTS_PORT` | `3210` | `scripts/agents-mode.mjs` (stable backend PORT; derives worker's `BRIGADIR_CALLBACK_BASE_URL=http://127.0.0.1:<port>/api/callbacks`) |
| `BRIGADIR_WORKER_MODE` | `dev` | worker lock identity label |
| `BRIGADIR_WORKER_LOCK_TTL_MS` | `15000` | lock TTL; renewal at TTL/3 |
| `BRIGADIR_CHANNEL_HEALTH_WINDOW_MS` | `900000` (15 min) | health service window |
| `BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD` | `3` | channel_failure degraded threshold |

Existing knobs reused unchanged: `BRIGADIR_MCP_CONFIG_ROOT` (shared across
modes on purpose), `BRIGADIR_CALLBACK_BASE_URL`, `BRIGADIR_OUTBOX_RETENTION_MS`
(also governs breadcrumb retention), probe/guard vars from 026.

# Research: Callback-Channel Resilience Ops (027)

**Date**: 2026-07-21 · **Spec**: [spec.md](spec.md)

All file references verified against the worktree at research time. Feature 026
(durable run finalization v2) is merged; its primitives referenced below exist.

## R1. Stable serving mode = second native non-watch pair (how, exactly)

**Decision**: A plain-Node CLI `scripts/agents-mode.mjs` (new `scripts/` dir)
with `start | stop | status` subcommands, exposed as root npm scripts
`agents:start` / `agents:stop` / `agents:status`. `start` builds
(`contracts → mcp-server → nest build backend → nest build worker`), then
spawns two detached children with pidfiles and log files under a gitignored
`.agents-mode/` dir:

- **Stable backend**: `node --env-file=.env dist/apps/backend/main.api.js`
  with `PORT=${BRIGADIR_AGENTS_PORT:-3210}`.
- **Stable worker**: `node --env-file=.env dist/apps/worker/main.worker.js`
  with `BRIGADIR_CALLBACK_BASE_URL=http://127.0.0.1:<agents-port>/api/callbacks`
  and `BRIGADIR_WORKER_MODE=agents`.

`stop` signals via pidfiles (SIGTERM; worker has `enableShutdownHooks` and
BullMQ graceful drain — compose already uses `stop_grace_period: 35s` as
precedent). `status` reports process liveness + `GET /health` +
`GET /api/callbacks/health` on the agents port.

**Rationale**:
- Dev mode already runs built bundles (`docs/local-setup.md` §2: 4 terminals,
  `node --env-file=.env dist/apps/*/main.*.js`); there is **no watch script in
  the repo** — the SPOF is that the human restarts/rebuilds the :3000 pair
  while hacking. A second pair on its own port is exactly the existing dev
  workflow, made long-lived and decoupled.
- The only listener is the backend (`apps/backend/src/main.api.ts:45`,
  `PORT ?? 3000`); the worker is a Nest application context with no port —
  so a second pair needs exactly one new port.
- Worker→backend coupling is already a single env:
  `BRIGADIR_CALLBACK_BASE_URL` (read lazily in
  `apps/worker/src/claude-cli-run.processor.ts:619` and
  `apps/worker/src/channel-probe.ts:34`; default `http://127.0.0.1:3000/api/callbacks`).
- The pair MUST share `BRIGADIR_JWT_SECRET` with itself (worker signs run
  JWTs — `signRunToken`, processor:624; backend guard verifies —
  `libs/callback/src/run-token.guard.ts:48`). Reusing the same `.env` for both
  stacks keeps dev and stable pairs verifying each other's tokens too, which
  is required during drain-based mode switches (a run spawned by the dev
  worker may still be delivering callbacks while the stable pair comes up).
- `node --env-file` is the documented way to load `.env`
  (local-setup.md L67: `pnpm start:backend` does NOT pick it up) — the
  script spawns children with `--env-file=.env` plus explicit overrides, no
  dotenv dependency needed (Node ≥ 22).
- No new external dependencies: plain `node:child_process`/`node:fs`; no
  `concurrently`, no pm2.

**Alternatives considered**:
- *Compose agent stack*: rejected — the `node:22-alpine` image has no
  `claude` CLI/auth, compose carries none of the three boot-required secrets,
  and container-vs-host filesystem splits the outbox/breadcrumb config root
  between tool server (spawned by worker) and reconciler. Fine for the
  API/dashboard plane, wrong for spawning real `claude_cli` runs.
- *Discipline-only*: rejected in clarify — SPOF remains.
- *systemd/launchd unit*: over-scoped for an internal tool; the script is
  portable and reviewable.

**Shared config root is deliberate**: both modes keep the default
`resolveMcpConfigRoot()` (`libs/executors/src/claude-cli/mcp-config.ts:40`,
`BRIGADIR_MCP_CONFIG_ROOT` else `<os.tmpdir()>/brigadir/mcp-config`). The
outbox/breadcrumb reconciler of whichever worker is active can then rescue
files written under the other mode. Safe because (a) the worker lock (R2)
guarantees a single consumer, and (b) every reconcile write is status-guarded
(`RunsService.reconcileWithReport`, `libs/runs/src/runs.service.ts:116`).

## R2. Worker exclusivity = Redis-held exclusive lock gating queue consumption

**Decision**: New `WorkerLockService` + bootstrap in `apps/worker`:

- Key `${BULLMQ_PREFIX ?? 'bull'}:worker-lock` (prefix read lazily, same as
  `libs/queues/src/queues.module.ts:58`); value = JSON
  `{ mode, pid, hostname, acquired_at }` where `mode` comes from
  `BRIGADIR_WORKER_MODE` (default `dev`).
- Acquire with `SET NX PX <ttl>`; TTL default **15s**
  (`BRIGADIR_WORKER_LOCK_TTL_MS`), renewed every TTL/3 via a Lua
  compare-and-extend (renew only if value matches own identity). Release on
  shutdown via Lua compare-and-del.
- **All WorkerHost processors start paused** and are resumed only after the
  lock is acquired (BullMQ `Worker#pause()/resume()`; NestJS `WorkerHost`
  exposes the underlying worker). Renewal loss ⇒ immediate re-pause +
  error log + re-enter acquire loop.
- Loud on both sides: a contender that fails to acquire logs **error-level**
  every attempt (~2s) naming the current holder, AND writes a side key
  `${prefix}:worker-lock:contender` (TTL 30s) with its identity; the holder's
  renewal tick checks that key and error-logs "another worker is attempting
  to consume these queues" with the contender identity.
- Holder death without release ⇒ TTL expiry ⇒ bounded takeover (≤ TTL), the
  spec's lock-recovery edge case.

**Rationale**:
- No locking exists today (verified: no advisory locks, no leader election;
  `per-issue-write-queue.ts:9` is in-process only). BullMQ job locks do NOT
  prevent two workers consuming the same queues — they just partition jobs,
  which is exactly the double-consumption failure (a dev worker with a dead
  callback URL racing jobs away from the stable worker).
- Keying by BullMQ prefix makes integration suites (unique
  `BULLMQ_PREFIX = bull-t<n>` per suite, `test/integration/harness.ts:120`)
  automatically isolated — no test churn.
- Pausing rather than exiting keeps drain-then-takeover automatic: the dev
  worker shuts down → releases lock → the waiting stable worker acquires and
  resumes within seconds. This implements the clarified "drain" posture with
  zero operator choreography.
- Redis is "queues + transient flags" per Constitution I — a coordination
  lock is a transient flag, not durable state.

**Alternatives considered**: queue-prefix separation (rejected in clarify —
strands jobs across modes); detection-only (rejected — race window);
Postgres advisory lock (worker already holds Redis for BullMQ; pg advisory
locks pin a session/connection and add a second coordination substrate).

## R3. Breadcrumbs: writer in mcp-server, `.brigadir-channel/<runId>.jsonl`

**Decision**:
- New `packages/mcp-server/src/channel-breadcrumbs.ts`:
  `appendChannelBreadcrumb(markerPath, runId, record)` → appends one JSON
  line to `<dirname(markerPath)>/.brigadir-channel/<runId>.jsonl`
  (mkdir recursive; `appendFile`). Same posture as the outbox writer
  (`outbox.ts:34-48`): whole body in try/catch, never throws, never delays
  the tool result. Volume bound: skip append when the file already exceeds
  **64 KB** (a 15-min outage at summary granularity is ≪ that).
- Record (summary-per-exhaustion, per clarify): `{ ts, tool, kind:
  'network' | 'http', attempts, error: { name, message }, status?, target }`
  — `target` is the URL host:port only, never the full URL path (path embeds
  `runId` only, but keep it minimal), never headers/tokens.
- Hook points in `packages/mcp-server/src/tools.ts` `fetchWithRetry`
  (133–185): the two exhaustion branches — network budget exhausted (the
  synthetic `{status: 0}` return, lines 158–163) and 5xx budget exhausted
  (line 176–177). Both are "delivery gave up" evidence; `kind`
  distinguishes them. Threading: `createToolHandlers` cfg gains an optional
  `onExhausted(record)` — the handlers construct it with tool name +
  markerPath so `fetchWithRetry` stays transport-only.

**Rationale**: the tool server is the only witness (spec); the outbox
already proves the marker-dir-derived convention works across the
process boundary (`dirname(BRIGADIR_MARKER_PATH)` on the writer side,
`resolveMcpConfigRoot()` on the reader side — same directory,
`libs/executors/src/claude-cli/outbox.ts` mirrors it). JSONL because a run
can exhaust several tools/times; append-only, no read-modify-write.

**mcp-server stays dependency-free**: the writer emits a plain object; the
zod schema for the record lives in `packages/contracts`
(`channel.schema.ts`) and is enforced by the **reader** (worker) per line
(invalid lines skipped + warn-once). mcp-server unit tests assert the
written shape against the contract fixture keys; the real-fetch contract
suite (tools.spec.ts, "over real HTTP" block, lines 509–636) gains a
refused-connection case asserting a breadcrumb line lands with
`attempts = 11` (1 + `maxNetworkErrorRetries` 10).

**Alternatives considered**: per-attempt records (rejected in clarify —
volume); reusing stderr parsing (rejected — buried in CLI cache logs, the
incident's exact problem); writing into the outbox file (rejected — outbox
has an existence-iff-unconfirmed invariant that breadcrumbs would break).

## R4. Ingestion: exit-path + periodic reconciler, event type `channel_failure`

**Decision**:
- New reader helpers in `libs/executors/src/claude-cli/channel-breadcrumbs.ts`
  (mirror of `outbox.ts`): `channelBreadcrumbDirPath`, `listChannelBreadcrumbFiles`,
  `claimChannelBreadcrumbFile` (atomic `rename(f, f + '.ingesting')` — the
  winner of a concurrent exit-path/reconciler race gets ENOENT-free rename,
  the loser no-ops), `readClaimedBreadcrumbs` (per-line parse via contract
  schema, invalid lines dropped), `consumeClaimed` (rm best-effort).
- **Exit path**: `apps/worker/src/claude-cli-run.processor.ts` — after every
  terminal branch for callback-wired runs (`completed`-mapped finalization,
  `timed_out`, `cancelled`, fail-closed, retry-exhausted crash), call a new
  `ChannelBreadcrumbIngest.ingest(runId, 'exit')` best-effort (never affects
  the run's finalization; wrapped like `recordCostUsage`).
- **Periodic**: `OutboxReconcileService.run()`
  (`apps/worker/src/outbox-reconcile.service.ts:45`) gains a second scan over
  `.brigadir-channel/*.jsonl`: files whose runId is a known run in a
  **terminal** status → claim + ingest + consume; active runs (`queued`,
  `running`, `awaiting_human`) → skip (agent may still append); unknown
  ids/invalid names → same 7-day retention + warn-once posture as outbox
  (`DEFAULT_RETENTION_MS`, `warnedInvalid`).
- **Event**: one `run_events` row per breadcrumb record, `type =
  'channel_failure'` (new constant next to `CHANNEL_DOWN_EVENT`), payload =
  breadcrumb record + `{ source: 'exit' | 'reconcile', occurred_at: <ts> }`
  (`created_at` is ingestion time; `occurred_at` is when delivery gave up —
  the timeline shows `occurred_at`).
- **Scrubbing**: breadcrumb `error.message` passes the existing secret
  scrubber before insert (Constitution V; messages originate from undici
  errors and should be inert, but scrub anyway).
- Idempotency: the rename-claim makes double-ingestion structurally
  impossible for a given file; ingestion after a run is long-finalized is
  allowed and attaches late diagnostics without touching status (spec edge
  case) — no status writes anywhere in this path (Выстраданное правило 7).

**Rationale**: reuses the exact scan/retention/warn patterns of the 026
reconciler; `run_events.type` is free-text (`libs/database/src/schema/run-events.ts:13`)
so no migration; `channel_failure` (client-side delivery gave up) is
deliberately distinct from `channel_down` (worker-side probe failed) — they
answer different questions and both feed the health aggregate.

**Alternatives considered**: pre-insert existence check à la
`attachUndeliveredReport` (insufficient alone for multi-record files — the
race window between check and insert spans N inserts); a dedicated table
(rejected — run_events preferred, no schema change); ingesting active runs'
files mid-run (rejected — file still being appended; exit/terminal-only is
lossless since the process is dead by then).

## R5. Health aggregate: derived on demand, no new storage

**Decision**: `GET /api/channel-health` (additive, `DashboardTokenGuard`,
new `apps/backend/src/dashboard/channel-health.controller.ts` + service).
Response (contract `ChannelHealthResponseSchema`):

```
{
  status: 'healthy' | 'degraded',
  window_ms, generated_at,
  last_successful_callback_at: string | null,
  channel_failures_in_window: number,   // run_events type='channel_failure'
  probe_failures_in_window: number,     // run_events type='channel_down'
  deployment_guard: { ok: boolean, reason: 'missing'|'stale'|null },
  affected_runs: [{ run_id, ticket_key|null, last_event_at }]  // capped 20
}
```

- **Degraded** (clarified): `probe_failures_in_window >= 1` OR
  `channel_failures_in_window >= threshold (default 3)` OR
  `deployment_guard.ok === false`. Window default **15 min**. Env:
  `BRIGADIR_CHANNEL_HEALTH_WINDOW_MS`, `BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD`
  — read lazily at request time with inline defaults (ChannelProbe
  precedent), documented in `.env.example`.
- **Deployment guard**: the backend calls the existing pure
  `checkMcpServerArtifact()` (`libs/executors/src/claude-cli/artifact-guard.ts:73`)
  through a memoized instance (`createMemoizedArtifactGuard`, TTL 10s) —
  backend and worker share the host filesystem in the native-pair mode, so
  the check is valid from either process. No cross-process status plumbing.
- **last_successful_callback_at**: derived from `run_events` rows of type
  `progress` whose payload carries `via: 'callback'` — a new additive field
  set at the single live-callback insert site
  (`libs/callback/src/callback.service.ts:62`). Pre-existing rows lack the
  tag and are simply not counted (display null until first tagged event).
  This is an approximation (a run could complete without ever calling
  `report_progress`); accepted and documented — the degraded logic never
  depends on it, it is operator context only.
- Window queries filter `created_at > now() - window` on two type values;
  `run_events` has only the `(run_id, id)` index, so these are recent-tuple
  scans. Accepted for an internal tool at current volume; if it ever hurts,
  a partial index is a one-line migration behind the documented §3 process
  (explicitly out of scope now — no schema change).

**Alternatives considered**: in-memory counters in the backend (rejected —
two backends exist in this feature; DB derivation is instance-agnostic);
new probe/health table (rejected — run_events suffices); tagging live
`complete` callbacks with an extra event (rejected — timeline noise for a
marginal precision gain on an informational field).

## R6. Dashboard surface

**Decision**:
- **Indicator**: new `ChannelHealthIndicator.vue` mounted in
  `AppSidebar.vue`'s `.sidebar-bottom` (the established global-status spot;
  the human-queue `el-badge` is the precedent). Compact lucide icon
  (`Activity`), static per icon rules; healthy = muted default; degraded =
  `--el-color-danger` accent + dot badge. Click opens an `el-popover` with:
  status line, last successful callback (relative), failure/probe counts,
  guard verdict, and the affected-runs list linking to `/runs/:id`.
  Needs `openCount`-style prop drilling? No — the indicator owns its own
  composable (sidebar is presentational today, but the human-task count
  query precedent lives in App.vue; the indicator query lives in the
  component itself to keep App.vue untouched — deviation from the
  `openCount` pattern is deliberate and local).
- **Polling**: `useChannelHealth` composable — `refetchInterval: 5000`,
  `placeholderData: (prev) => prev` (house pattern, `useRuns.ts:18-19`).
  SC-004's "one polling interval" = 5s.
- **Runs list marker**: additive `callback_alert: boolean` on
  `RunListItemSchema` (`packages/contracts/src/runs.schema.ts:48`, strict —
  server must project it) computed in the workspace runs list query
  (`apps/backend/src/dashboard/runs.controller.ts:43`) as an EXISTS over
  `run_events` with `type IN ('undelivered_report','channel_failure')` —
  literally reusing the 026 mechanism (the run-event IS the marker; the
  list field is a projection of it). UI: small `MailWarning` icon with
  tooltip in the Status column cell of `Runs.vue`.
- **Run detail marker**: no API change — `RunCardResponse.events[]` already
  carries the rows; the run card derives the marker client-side and the
  timeline renders the events.
- **Timeline rendering**: new `channel_failure` presenter case following the
  documented 4-step recipe (`presenter.ts`: add to `TimelineTypeKey` union +
  `KNOWN_TYPES`, write `presentChannelFailure` — kv body with tool,
  attempts, error, target, occurred_at; `TimelineEvent.vue`: `Unplug` icon,
  `--el-color-danger` accent). Russian label consistent with 026's
  «Недоставленный отчёт» card.

## R7. Test strategy (Constitution VI / Principle IV)

- **mcp-server unit** (`packages/mcp-server/src/tools.spec.ts` +
  `channel-breadcrumbs.spec.ts`): writer never-throws (EROFS dir), record
  shape vs contract fixture, 64 KB cap; mock-suite cases for both exhaustion
  kinds; **real-fetch contract case**: refused connection over real undici →
  JSONL line with `attempts: 11`, outbox still present.
- **Worker unit** (`apps/worker/src/*.spec.ts`,
  `libs/executors/src/claude-cli/channel-breadcrumbs.spec.ts`): claim/rename
  race (two concurrent claims → one winner), per-line parse drops invalid,
  retention.
- **Integration** (testcontainers, real PG+Redis, unique `BULLMQ_PREFIX`,
  never `flushdb`):
  - `worker-lock.spec.ts`: second worker same prefix consumes nothing +
    error surface; holder release → takeover; TTL expiry after SIGKILL'd
    holder → bounded takeover; contender visibility on holder side.
  - `channel-breadcrumbs.spec.ts`: end-to-end file → terminal-branch
    ingestion → `channel_failure` rows; reconciler path for a crashed
    worker; exit/reconciler race → no duplicate rows; active-run file
    untouched.
  - `channel-health.spec.ts`: seeded events/guard states → status matrix,
    threshold boundary, window expiry → auto-recovery, `affected_runs` cap.
  - runs-list `callback_alert` projection.
- **Web component** (`apps/web/test/*.spec.ts`, msw):
  `channel-health-indicator.spec.ts` (healthy/degraded/popover/links),
  `run-timeline-presenter.spec.ts` + `run-timeline-event.spec.ts` additions
  (`channel_failure`), `runs-table.spec.ts` marker column.
- **Manual scenario** (quickstart): SC-001 — stable mode up, run in flight,
  kill dev pair, run completes clean.

## Resolved unknowns from Technical Context

| Unknown | Resolution |
|---|---|
| Where retry exhaustion is decided | `fetchWithRetry` two budget guards, `tools.ts:158/176`; returns synthetic result, never throws |
| Marker-dir convention crossing processes | `dirname(BRIGADIR_MARKER_PATH)` ↔ `resolveMcpConfigRoot()`; proven by outbox |
| run_events extensibility | free-text `type` column; no migration needed |
| 026 undelivered-report surfacing | run_events row only; no list/detail flag exists yet — list flag is new work (R6) |
| Probe/guard code reuse | `ChannelProbe` + `checkMcpServerArtifact` are importable pure pieces; backend can run the guard directly |
| Existing watch scripts | none — "dev-watch" is the human's manual workflow; mode = second pair of the same built bundles |
| JWT topology for two pairs | single shared `.env` secret; both backends verify all run tokens |
| Queue namespace | single (`bull`), lock keyed by prefix; suites isolated by per-suite prefix |

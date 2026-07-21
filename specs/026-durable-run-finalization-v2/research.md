# Phase 0 Research: Durable Run Finalization v2

All spec-level unknowns were resolved in `/speckit-clarify` (see spec
Clarifications). This document records the **implementation-level**
decisions derived from reading the live codebase (paths as of branch base
`84eed1b`).

## D1 — Guard placement & failure surface (spec Q1 hybrid)

**Decision**: A pure function
`checkMcpServerArtifact({entryPath, srcDir}) → {ok:true, skipped?} | {ok:false, reason:'missing'|'stale', entryMtime?, newestSrc?}`
in `libs/executors/src/claude-cli/artifact-guard.ts`, consumed twice:
1. **Startup**: a small `ArtifactGuardBootstrap` provider
   (`OnApplicationBootstrap`) in `apps/worker` logs an error-level,
   multi-line banner on violation (path, mtimes, remedy
   `pnpm build:mcp-server`). The worker still starts.
2. **Pickup**: in `ClaudeCliRunProcessor.process()`, after `load()` and
   only when `loaded.useCallbackChannel === true`, before
   `checkExecutorGate`/`markRunning`. On violation: error log + finalize
   the run as `failed` with the same explicit error in `extra.error`, then
   `afterFinalize()` (pipeline sees a normal terminal run). The run is
   `queued` at this point (nothing else owns it), so plain
   `finalizeStatus` is safe and rule-7-compliant — there is no concurrent
   status owner before `markRunning`.

**Rationale**: matches Clarification Q1 exactly; failing the run (vs
holding it) is the clarified choice — fail-fast visibility, operator
rebuilds and re-triggers. The check re-runs per pickup (memoized 10 s) so
a rebuild heals the worker **without restart**.

**Alternatives considered**: refusing worker boot (blocks Phase-0/mock
runs — rejected in clarify); holding via rateLimit like D (hides the
problem — rejected in clarify); checking only at startup (a rebuild would
require a worker restart to be noticed, and a worker started before an
edit would keep spawning stale binaries — rejected).

## D2 — Freshness definition & path resolution

**Decision**: extract the executor's private `resolveMcpServerEntryPath()`
(`claude-cli.executor.ts:381-384`, env override `BRIGADIR_MCP_SERVER_ENTRY`,
default `<cwd>/packages/mcp-server/dist/main.js`) into a shared
`mcp-server-path.ts` module; add `resolveMcpServerSrcDir()` (new env
override `BRIGADIR_MCP_SERVER_SRC`, default
`<cwd>/packages/mcp-server/src`). Staleness = `mtime(entry) <
max(mtime of every file under srcDir, recursive)`. If `srcDir` does not
exist → existence-only check, `{ok:true, skipped:'no-src-dir'}` with a
debug log (covers pruned-source deployments; our Docker image copies
sources, so the full check runs there).

**Rationale**: same-machine mtime comparison is what the spec assumes; the
env overrides are what integration tests use to simulate stale/fresh
without touching the real package. Reusing the exact resolver the executor
spawns from guarantees the guard checks the file that will actually run.

**Alternatives considered**: content hashing (no benefit on one machine,
slower, and a rebuild-on-false-positive costs seconds — rejected);
comparing against git HEAD timestamps (breaks on dirty worktrees — the
incident's own scenario — rejected).

## D3 — Build wiring (guard should never fire)

**Decision**: root `package.json`:
`"start:worker": "pnpm build:mcp-server && node dist/apps/worker/main.worker.js"`.
No other wiring needed: root `build` already chains
`@brigadir/mcp-server` build, so the Docker image (single `pnpm build`
layer) is already correct; `pnpm build:mcp-server` exists.

**Rationale**: `start:worker` is the only entry point that can currently
reach a stale artifact (dev machine, incremental edits). pnpm does not run
npm-style `pre*` hooks by default, so explicit chaining beats a `prestart`
hook that silently wouldn't fire.

**Alternatives considered**: `.npmrc enable-pre-post-scripts` (repo-wide
behavior change for one script — rejected); watch-mode `tsc -w` for
mcp-server in dev (new long-running process, out of scope — rejected).

## D4 — Exit-time widening: branch-by-branch mapping

**Decision** (in `ClaudeCliRunProcessor.process()`, callback-wired runs
only):
- **`completed` exit, run still running** (current fail-closed at
  `claude-cli-run.processor.ts:279-295`): first `readOutboxReport`; if
  present → `ReportSchema.parse` + `scrubAgentReport` + `finalizeWithReport`;
  on `flipped` → `consumeOutbox` + `afterFinalize` + return; on parse
  failure → **leave the file** (FR-007: preserved for inspection; the
  periodic reconciler's retention will age it out) and fall through to the
  existing `failIfStillRunning` fail-closed write.
- **`timed_out`** (existing reconcile at 350-366): keep control flow, add
  the same scrub step before `finalizeWithReport` (closes the pre-existing
  Constitution-V gap).
- **`cancelled` finalize**: before `finalizeStatusIfRunning`, if an outbox
  report exists and parses → write one `undelivered_report` run-event
  (scrubbed) + `consumeOutbox`; if it exists but does not parse → leave the
  file (retention path). Status flow unchanged.
- **`rate_limit` action**: NOT a terminal status in this codebase (the
  spec's "rate_limited" maps to a park: `worker.rateLimit()` +
  `RateLimitError`, run row stays active). Exit-time does **nothing** with
  the outbox here — the run is still live and will either retry or be
  rescued by the periodic reconciler's `running` rule. This is the correct
  translation of the spec's "never flip the status" for a state that is
  not actually terminal.
- **`retry` action**: untouched (run returns to `queued`, still active).

**Rationale**: minimal diff inside the exact branches named by the
incident; every write keeps the rule-7 guard via `finalizeWithReport`'s
own guarded UPDATE / the `flipped` flag.

## D5 — Undelivered report surfacing (spec Q2)

**Decision**: one `run_events` row, `type = 'undelivered_report'`,
payload `{ report, run_status, source: 'exit_reconcile' | 'periodic_reconcile' }`
where `report` is the schema-valid, scrubbed report. Before insert, check
for an existing `undelivered_report` event for the run (cheap indexed
`(runId, id)` scan) — skip insert if present (idempotence across
exit-time/periodic races). Web: add a presenter case + icon in
`RunTimeline/presenter.ts` (`KNOWN_TYPES`) and `RunTimeline.vue`; unknown
types already render generically, so the presenter is polish, not a
functional dependency. Only schema-valid reports are ever attached —
invalid files stay on disk under the retention policy instead of dumping
unvalidated bytes into the DB.

**Rationale**: matches Clarification Q2 (run-event, no schema change —
`run_events.type` is free text per `libs/database/src/schema/run-events.ts`;
no one-click re-finalize). The dedup check keeps B and C idempotent
without a DB constraint.

**Alternatives considered**: unique partial index on
`(run_id) WHERE type='undelivered_report'` (schema change → §3 update —
rejected as unnecessary for a single-worker internal tool); human_task
(rejected in clarify).

## D6 — Periodic reconciler mechanics (spec Q4)

**Decision**: clone the proven `ReconcileScheduler`/`ReconcileProcessor`
pattern: new constant `OUTBOX_RECONCILE_QUEUE = 'outbox-reconcile'` in
`libs/queues` (composition-time queue name = sanctioned static structure,
documented at the call site), `OutboxReconcileScheduler` calls
`upsertJobScheduler('outbox-reconcile', { every: 60_000 })` in
`onApplicationBootstrap` (idempotent by scheduler id), processor delegates
to `OutboxReconcileService.run()` — one pass:

1. `listOutboxEntries(configRoot)` — read dir
   `<defaultMcpConfigRoot(tmpdir())>/.brigadir-outbox`, missing dir ⇒
   empty scan.
2. Per file: derive `runId` from filename; load run row; apply the
   resolution matrix (see `contracts/outbox-protocol.md`):
   `running` / `failed`·`timed_out` with `outcome IS NULL` → scrub +
   `finalizeWithReport`; on `flipped` → `onRunFinished` + consume; not
   flipped → consume (someone else won).
   `cancelled` / `superseded` → attach `undelivered_report` (D5 dedup) +
   consume. `awaiting_human` → **skip, do not consume** (live human
   completion path). Finalized with outcome, or unknown run id → consume +
   log. Unparseable/invalid → leave file; warn once per worker lifetime
   (in-memory set) to avoid 60 s log spam.
3. Retention: any remaining file with mtime older than 7 days → delete +
   log line.

**Jitter**: dropped. BullMQ `every` has no jitter option and the
deployment is a single worker — there is no thundering-herd peer to avoid.
Recorded here as a conscious deviation from the spec assumption's "with
small jitter" wording (the assumption's intent — cheap, non-bursty scans —
holds trivially).

**Rationale**: reuses the only scheduler pattern in the repo
(`reconcile.scheduler.ts:17-20`); 60 s cadence satisfies SC-002's
"within two cadence intervals". `superseded` is grouped with `cancelled`
(intentional stop — never flip, never lose the report), which the spec
did not enumerate; recorded as a plan-level completion of the matrix.

**Alternatives considered**: `setInterval` à la `startConcurrencyReapply`
(loses BullMQ's overlap protection and observability — rejected);
extending the existing 5-min `ReconcileService` (couples Jira
reconciliation cadence to outbox rescue latency, 5 min > SC-002 budget —
rejected).

## D7 — Race-safety model (B ↔ C ↔ live callback)

**Decision**: rely exclusively on the existing guarded UPDATE inside
`finalizeWithReport` (`WHERE status IN (queued,running,awaiting_human)`,
returns `flipped`) — no file locks, no advisory locks. All contenders
(live callback, exit-time reconcile, periodic reconciler) submit the SAME
report content, so whichever wins produces the same DB state;
losers observe `flipped === false` and only consume the file. The
transient window where the tool server has written the outbox but the
2xx-delete hasn't happened yet is benign for the same reason.
`run_checks`/`human_tasks` are written only by the winner (inside
`finalizeWithReport`'s flip branch), so no duplication.

**Rationale**: this is exactly rule 7's design; adding locking would be a
second mechanism to maintain without a failure mode it fixes.

## D8 — Pre-flight probe mechanics (spec Q3)

**Decision**: `channel-probe.ts` in `apps/worker`:
- Probe = `fetch(healthUrl, { signal: AbortSignal.timeout(2000) })` where
  `healthUrl = <BRIGADIR_CALLBACK_BASE_URL or default>/health`; alive ⇔
  HTTP 2xx. Env read lazily at pickup (rule 1).
- Wired into `process()` for callback-wired runs only, after the artifact
  guard, **before** `checkExecutorGate`/`markRunning` — run stays
  `queued`, attempt not consumed.
- On failure: increment in-memory per-run consecutive counter; write a
  `channel_down` run-event `{ probe_url, consecutive, retry_in_ms }`
  (operator visibility — the existing gate hold is logs-only, which the
  spec's FR-014 explicitly upgrades); log warn, escalating to error at
  `consecutive >= 3` (Clarification Q3 alert threshold); hold via
  `await worker.rateLimit(ttl)` + `throw Worker.RateLimitError()` with
  `ttl = min(30_000 · 2^(consecutive-1), 300_000)`.
- On success: reset the counter, proceed.

**Rationale**: matches Clarification Q3 (reuse the hold path, distinct
reason, threshold 3). The known tradeoff that `worker.rateLimit` pauses
the whole per-type queue is acceptable — a dead channel affects every
callback-wired run on that queue anyway. Counters are in-memory only
(worker restart resets backoff — harmless; the run-event trail persists).

**Alternatives considered**: probing the run-scoped callback URL with the
run JWT (heavier, couples probe to token minting — rejected); HEAD request
(some Nest setups 404 HEAD-only routes; GET of a static body is equally
cheap — rejected).

## D9 — Health endpoint

**Decision**: new `CallbackHealthController` in `libs/callback`:
`@Controller('api/callbacks')`, `@Get('health')`, **no guard**, returns
`{ status: 'ok' }` (200). Static liveness only — no DB touch, no version
info, no config echo.

**Rationale**: the 2026-07-19 outage class is "backend process down"; a
process that answers 200 has a listening HTTP stack and routing — exactly
what the callbacks need at transport level. The existing
`CallbackController` prefix is `api/callbacks/runs/:runId`, so a sibling
controller (not a new route on it) keeps the guarded surface untouched
(FR-016). A DB-readiness probe would create false "channel down" holds
during transient DB blips that the callback path itself would survive via
retries — deliberately out of scope, limitation stated in the spec.

## D10 — Scrubbing (Constitution V choke point)

**Decision**: move the private `scrubReport` from
`libs/callback/src/callback.service.ts:43` to an exported
`scrubAgentReport(report: AgentReport): AgentReport` in
`libs/callback/src/report-scrub.ts`; `CallbackService` imports it
(behavior unchanged, its specs keep passing). Worker reconcile paths (B
exit-time completed, existing timed_out — retrofit, C periodic, D5 event
payloads) all do `ReportSchema.parse` → `scrubAgentReport` → persist.

**Rationale**: field-aware scrubbing (only free-text fields) avoids the
entropy scrubber mangling structural values (commit SHAs, branch names) —
a real risk of a naive deep-scrub of every string. One shared function =
one Constitution-V audit point. The worker importing `@brigadir/callback`
for a pure function pulls no Nest module wiring.

**Alternatives considered**: scrubbing inside `finalizeWithReport` (adds a
`libs/runs → libs/callback` or scrubber+contracts coupling and double-scrubs
the live callback path; more invasive to a hot path — rejected, though it
remains a reasonable future consolidation); generic `scrubDeep` in
`libs/scrubber` (entropy false positives on hashes — rejected).

## D11 — Integration-test strategy

**Decision**: follow `test/integration/claude-cli-harness.ts` conventions
(fake CLI via `executors.config.cliPath`, `setupClaudeCliTestEnv`, unique
`BULLMQ_PREFIX`, real `WorkerAppModule`):
- **Guard suite**: point `BRIGADIR_MCP_SERVER_ENTRY`/`_SRC` at scratch
  files with controlled mtimes (`utimes`); assert callback-wired run →
  `failed` with the explicit error, mock/Phase-0 run unaffected, fresh
  artifact → normal lifecycle.
- **Exit-time suite (extend lifecycle spec)**: pre-place an outbox file
  under the harness config root, script the fake CLI to exit without
  callbacks → assert `succeeded` + outcome + checks + file consumed;
  cancelled-mid-run variant → status `cancelled` + `undelivered_report`
  event + file consumed; malformed-file variant → `failed` (fail-closed)
  + file still on disk.
- **Reconciler suite**: seed run rows in each matrix state + files, call
  `OutboxReconcileService.run()` directly (deterministic, no waiting on
  the 60 s tick), assert matrix outcomes + second-pass no-op + retention
  deletion (backdated mtime); scheduler idempotence asserted à la the
  existing reconcile T020 test.
- **Pre-flight suite**: set `BRIGADIR_CALLBACK_BASE_URL` to a dead port →
  enqueue → assert no fake-CLI side effects, run still `queued`,
  `attempt` unchanged, `channel_down` events accumulating; then bind a
  stub 200 server on that port → assert the run completes normally.
  Phase-0 run with dead URL → runs normally (no probe).

**Rationale**: everything crosses process/DB boundaries → integration per
Principle VI; direct `service.run()` calls keep the reconciler tests
clock-free (no `Date.now` games, no flaky sleeps).

## D12 — Web timeline presentation

**Decision**: add `undelivered_report` and `channel_down` to
`KNOWN_TYPES` + `presentEvent` in
`apps/web/src/components/RunTimeline/presenter.ts` with dedicated titles
(`Недоставленный отчёт`, `Канал недоступен`), compact payload summaries
(outcome + summary first line; probe URL + consecutive count), and icons
in `RunTimeline.vue` (lucide, static — no hover animation per UI
conventions). Unknown-type fallback already renders safely, so older
dashboards degrade gracefully.

**Rationale**: FR-006/FR-014 require operator visibility; presenter work
is the entire UI cost (no new endpoints — `GET api/runs/:id` already
returns all events).

# Quickstart: Validating Durable Run Finalization v2

Runnable scenarios proving each slice end-to-end. Contracts:
[contracts/](./contracts/), decision matrices:
[data-model.md](./data-model.md).

## Prerequisites

```bash
pnpm install
pnpm build                      # includes build:mcp-server (Docker uses the same chain)
docker info                     # testcontainers need a live Docker daemon
```

## Gates (must be green — spec SC-007)

```bash
pnpm typecheck && pnpm lint && pnpm test    # statics + units (guard, probe backoff, outbox listing)
pnpm test:integration                        # real Postgres/Redis via testcontainers
```

Phase-0 unaffectedness (SC-006) is proven by the existing suites passing
unmodified — no Phase-0 test is edited by this feature.

## Scenario A — deployment guard (SC-001)

```bash
# Simulate the incident: sources newer than the built artifact
touch packages/mcp-server/src/tools.ts
pnpm start:backend &            # backend up (guard doesn't need it, runs do)
node dist/apps/worker/main.worker.js   # start worker WITHOUT the build chain
```

Expected: error-level startup banner naming
`packages/mcp-server/dist/main.js`, both mtimes, and the remedy
(`pnpm build:mcp-server`). Trigger a callback-wired run (dashboard or
smoke flow) → run finalizes `failed` with the same explicit error, no
agent process spawned. A mock/Phase-0 run executes normally. Then:

```bash
pnpm build:mcp-server           # heal WITHOUT restarting the worker
```

→ next callback-wired run proceeds normally (10 s memo max delay).
`pnpm start:worker` (the wired dev entry) never shows the banner.

Automated: `test/integration/artifact-guard.spec.ts` (env overrides
`BRIGADIR_MCP_SERVER_ENTRY`/`_SRC` + `utimes`).

## Scenario B — verdict rescued at completed-exit (SC-002, the 3f60c1a1 case)

Automated in `test/integration/claude-cli-lifecycle.spec.ts` extensions:

1. Seed a callback-wired run; pre-place
   `<configRoot>/.brigadir-outbox/<runId>.json` with a valid
   `complete_task` report; script the fake CLI to exit cleanly WITHOUT
   calling any callback.
2. Expect: run `succeeded` with `outcome` from the report, `run_checks`
   written, outbox file gone, NO fail-closed `failed` write.
3. Malformed-file variant: run ends `failed` (fail-closed unchanged),
   file still on disk (FR-007).
4. Cancel variant: operator-cancel mid-run with an outbox file present →
   status stays `cancelled`, one `undelivered_report` run-event exists,
   file consumed (SC-003).

## Scenario C — periodic reconciler (SC-002 worker-death leg, SC-005)

Automated in `test/integration/outbox-reconcile.spec.ts`:

1. Seed runs in every matrix state (`running`, `failed`+`outcome NULL`,
   `timed_out`+`outcome NULL`, `cancelled`, `awaiting_human`, finalized
   with outcome, plus a file for an unknown run id and a corrupt file);
   place matching outbox files.
2. Call `OutboxReconcileService.run()` once → assert each row per the
   [resolution matrix](./data-model.md#periodic-reconciler-resolution-matrix-fr-008-d6):
   rescued rows finalized with the report's outcome; `cancelled` keeps
   status + gains the event; `awaiting_human` untouched, file kept;
   corrupt file kept.
3. Call `run()` again → zero additional writes (idempotence, SC-005).
4. Backdate the corrupt file mtime by 8 days, `run()` → file deleted +
   logged (retention).
5. Scheduler registration: booting `WorkerAppModule` twice upserts a
   single `outbox-reconcile` scheduler (idempotent by id).

Manual smoke: kill the worker mid-run after the agent's callback fails,
restart the worker → run finalizes within ~2 minutes (two 60 s ticks).

## Scenario D — pre-flight channel check (SC-004)

Automated in `test/integration/preflight-channel.spec.ts`:

1. Point `BRIGADIR_CALLBACK_BASE_URL` at a closed port; enqueue a
   callback-wired run.
2. Expect: fake CLI never spawned, run stays `queued`, `attempt`
   unchanged, `channel_down` run-events accumulate with growing
   `consecutive` and TTLs (30 s → 60 s → 120 s…), error-level log at the
   3rd failure.
3. Bind a stub HTTP 200 server on the port (or start the real backend —
   `GET /api/callbacks/health` now exists) → run proceeds and completes
   normally with its full attempt budget.
4. Phase-0 control: mock run with the same dead URL executes normally
   (no probe on its path).

Manual smoke (the 2026-07-19 replay): stop the backend, trigger a run
from Jira, watch the dashboard — run sits `queued` with «Канал
недоступен» timeline cards; start the backend — run executes.

## Dashboard check (FR-006/FR-014)

Open a run card with an `undelivered_report` / `channel_down` event:
timeline shows the dedicated cards («Недоставленный отчёт» with the
report's outcome/summary; «Канал недоступен» with consecutive count).
Older/unchanged dashboards still render both types via the generic
unknown-type card — acceptable degraded view, no lockstep deploy needed.

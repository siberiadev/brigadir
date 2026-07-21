# Quickstart: Validating Callback-Channel Resilience Ops (027)

Prerequisites: repo bootstrapped per `docs/local-setup.md` §0–§1 (`.env` with
the three secrets), Docker running, `claude` CLI logged in for live-run
scenarios. Contracts and details: [contracts/](contracts/),
[data-model.md](data-model.md).

## 0. Gates (run before and after any phase)

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration        # Docker required; builds mcp-server first
```

Expected: all green; Phase-0 suites unchanged.

## A. Stable serving mode + worker lock

1. **Enter the mode**:
   ```bash
   pnpm agents:start          # builds, then starts backend :3210 + worker (pidfiles in .agents-mode/)
   pnpm agents:status         # expect: both processes alive, /health ok, /api/callbacks/health ok
   curl -fsS http://127.0.0.1:3210/api/callbacks/health   # {"status":"ok"}
   ```
2. **SC-001 drill (callbacks survive dev churn)** — with the stable mode up,
   start a callback-wired run (any live agent on the board, or the smoke
   flow). While it is in flight: start/stop a dev backend on :3000, touch a
   source file, run a broken build. Expected: the run finalizes normally via
   `complete_task`; its run card shows NO `channel_failure`/`channel_down`
   events; `outcome` is set.
3. **SC-002 drill (double worker is loud)** — with the stable worker
   holding the lock, start a dev worker against the same Redis:
   ```bash
   node --env-file=.env dist/apps/worker/main.worker.js
   ```
   Expected within seconds: the new worker logs an ERROR naming the holder
   (`mode=agents pid=… host=…`) and consumes nothing; the stable worker's
   log gains an ERROR naming the contender. Enqueue a mock run → it is
   processed by the stable worker only.
4. **Drain-based switch** — stop the stable worker (`pnpm agents:stop`)
   while the dev worker from step 3 is still waiting. Expected: stable pair
   drains and releases; the dev worker acquires the lock within ~2 s and
   resumes consuming (its log says so). `kill -9` variant: takeover within
   the lock TTL (≤ 15 s).
5. **Guard/probe parity in the mode (FR-005)** — backdate the mcp-server
   artifact (`touch -t 202601010000 packages/mcp-server/dist/main.js`),
   enqueue a callback-wired run via the stable pair. Expected: identical
   026 behavior (run fails at pickup with the stale-artifact banner).
   Rebuild (`pnpm build:mcp-server`) → heals without restart (10 s TTL).

Automated coverage: `test/integration/worker-lock.spec.ts`.

## B. Breadcrumbs end-to-end

1. **Unit/contract**: `pnpm --filter @brigadir/mcp-server test` — includes
   the real-fetch case: refused connection ⇒ `.brigadir-channel/<runId>.jsonl`
   gains one line with `kind":"network"`, `"attempts":11`.
2. **Live scenario (SC-003)**: point a run's callbacks at a dead port —
   easiest: start ONLY the stable worker with
   `BRIGADIR_CALLBACK_BASE_URL=http://127.0.0.1:39999/api/callbacks` and no
   backend on that port… note the pre-flight probe will hold the run
   (channel_down); to exercise mid-run failure instead, kill the stable
   backend AFTER the run passes pre-flight. Expected after the run
   terminates (or ≤ 60 s later via the reconciler): the run detail timeline
   shows «Сбой callback-канала» cards (tool, attempts, last error, target,
   occurred_at) — no SQL needed; the breadcrumb file is gone from
   `$TMPDIR/brigadir/mcp-config/.brigadir-channel/`.
3. **Race/idempotency**: covered by
   `test/integration/channel-breadcrumbs.spec.ts` (exit + reconciler race ⇒
   no duplicate `channel_failure` rows; active-run files untouched; invalid
   lines dropped; 7-day retention for unknown ids).

## C. Health surface

1. **API**:
   ```bash
   curl -fsS -H "Authorization: Bearer $BRIGADIR_DASHBOARD_TOKEN" \
     http://127.0.0.1:3210/api/channel-health | jq
   ```
   Fresh system ⇒ `status:"healthy"`, null last-success, zero counts,
   `deployment_guard.ok:true`. After B's live scenario ⇒ `degraded`,
   non-empty `affected_runs`.
2. **SC-004 drill (indicator reacts within one poll)**: open the dashboard,
   watch the sidebar indicator; trigger a probe failure (stop the stable
   backend while a run is queued). Expected: indicator turns degraded ≤ 5 s
   after the `channel_down` row lands; popover shows counts and links to
   the affected run; after 15 min without new failures (or with
   `BRIGADIR_CHANNEL_HEALTH_WINDOW_MS=60000` for a fast drill) it returns
   to healthy with no action.
3. **Runs list marker**: the run from B shows the `callback_alert` icon in
   the list; clicking through lands on its timeline.
4. Automated coverage: `test/integration/channel-health.spec.ts` (status
   matrix, threshold boundary, window expiry, cap), web component specs
   (`channel-health-indicator`, `runs-table` marker, presenter cases).

## Rollback / exit

`pnpm agents:stop` returns the machine to the plain dev workflow; the lock
releases on drain and any single dev worker acquires it trivially. Feature
flags are not needed — A/B/C are additive and independently revertable by
commit.

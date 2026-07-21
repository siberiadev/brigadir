# Tasks: Durable Run Finalization v2 — Deployment Guard + Outbox Safety Net

**Input**: Design documents from `/specs/026-durable-run-finalization-v2/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D12), data-model.md (decision matrices), contracts/, quickstart.md

**Tests**: MANDATORY — every story here is pipeline logic (executor lifecycle, report processing, finalization) per constitution Principle VI. Integration tests run against real Postgres/Redis (testcontainers, unique `BULLMQ_PREFIX`, never `flushdb`). Write story tests first; they must fail before implementation.

**Organization**: US1=slice B (exit-time rescue), US2=slice A (deployment guard), US3=slice C (periodic reconciler), US4=slice D (pre-flight probe). Stories are independently mergeable; US1/US3 share Foundational T002–T003.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Verify green baseline before touching pipeline code: `pnpm build && pnpm typecheck && pnpm lint && pnpm test` and `docker info` (testcontainers prerequisite); confirm `test/integration/claude-cli-harness.ts` fake-CLI flow runs (`pnpm test:integration -- claude-cli-lifecycle`)

---

## Phase 2: Foundational (blocks US1 and US3 only; US2/US4 do not depend on this phase)

**Purpose**: shared report-persistence plumbing used by both outbox-reading stories (research D5, D10)

- [x] T002 Extract `scrubReport` from `libs/callback/src/callback.service.ts` into exported `scrubAgentReport(report: AgentReport): AgentReport` in new `libs/callback/src/report-scrub.ts`; re-export from `libs/callback/src/index.ts`; switch `CallbackService` to the import. Behavior identical — existing `callback.service.spec.ts` scrub tests must pass unmodified (they are the regression net for this move)
- [x] T003 [P] Create undelivered-report attach helper in new `apps/worker/src/undelivered-report.ts`: `attachUndeliveredReport(db, runId, report, runStatus, source)` — pre-insert existence check for an `undelivered_report` event on the run (dedup, research D5), insert `run_events` row with payload `{ report, run_status, source }` per `contracts/run-event-types.md`; report argument is already parsed+scrubbed by callers

**Checkpoint**: `pnpm typecheck && pnpm test` green; no behavior change anywhere yet

---

## Phase 3: User Story 1 — Verdict rescued at process exit (Priority: P1) 🎯 MVP

**Goal**: a callback-wired run whose agent wrote an outbox report but whose callbacks never landed finalizes with the report's outcome at `completed`-exit instead of fail-closing; `cancelled` stops preserve the report as an `undelivered_report` event. The exact `3f60c1a1` loss becomes impossible.

**Independent Test**: quickstart Scenario B — pre-place an outbox file, script the fake CLI to exit without callbacks, assert `succeeded` + outcome + consumed file; cancel variant keeps `cancelled` + gains the event.

### Tests for User Story 1 (write first, must fail) ⚠️

- [x] T004 [US1] Extend `test/integration/claude-cli-lifecycle.spec.ts`: (a) completed-exit rescue — seed callback-wired run, pre-place valid outbox file under the harness config root, fake CLI exits cleanly with NO callbacks → run `succeeded`, `outcome` from report, `run_checks` written, outbox file gone, no fail-closed `failed`; (b) already-finalized race — run finalized before exit processing → no overwrite (`flipped=false` path), file consumed; (c) malformed outbox file → run `failed` (fail-closed unchanged), file still on disk (FR-007)
- [x] T005 [US1] Extend `test/integration/claude-cli-lifecycle.spec.ts`: cancelled-with-outbox — operator-cancel mid-run with a valid outbox file present → status stays `cancelled`, exactly one `undelivered_report` run-event with scrubbed report + `run_status: 'cancelled'` + `source: 'exit_reconcile'`, file consumed; second processing produces no duplicate event (SC-003)

### Implementation for User Story 1

- [x] T006 [US1] Widen the `completed`-exit fail-closed branch in `apps/worker/src/claude-cli-run.processor.ts` (currently lines ~279–295): before `failIfStillRunning`, `readOutboxReport`; if present → `ReportSchema.parse` + `scrubAgentReport` + `finalizeWithReport(runId, report, extra)`; on `flipped` → `consumeOutbox` + `afterFinalize` + return; on `flipped=false` → `consumeOutbox` + return; on parse/validation failure → keep file, log, fall through to the existing fail-closed write (data-model exit-time matrix, research D4)
- [x] T007 [US1] Retrofit scrubbing into the existing `timed_out` reconcile branch in `apps/worker/src/claude-cli-run.processor.ts` (lines ~350–366): parse + `scrubAgentReport` before `finalizeWithReport` (closes the pre-existing Constitution-V gap, research D10); on schema-invalid report keep the file (retention path) instead of consuming
- [x] T008 [US1] Wire the `cancelled` finalize branch in `apps/worker/src/claude-cli-run.processor.ts`: when `decision.status === 'cancelled'` and a valid outbox report exists → `attachUndeliveredReport(..., 'exit_reconcile')` + `consumeOutbox` BEFORE the unchanged guarded `finalizeStatusIfRunning`; invalid file → keep. `rate_limit`/`retry` actions remain byte-identical (non-terminal, research D4)
- [x] T009 [P] [US1] Dashboard presenter for `undelivered_report` in `apps/web/src/components/RunTimeline/presenter.ts` (add to `KNOWN_TYPES`, card title «Недоставленный отчёт», summary = report outcome + first line of summary + source) and icon/accent in `apps/web/src/components/RunTimeline/RunTimeline.vue` (lucide, static — no hover animation per UI conventions; research D12)

**Checkpoint**: quickstart Scenario B passes; `3f60c1a1` replay rescued; Phase-0 suites untouched and green

---

## Phase 4: User Story 2 — Stale artifact cannot run silently (Priority: P2)

**Goal**: missing/stale `packages/mcp-server/dist/main.js` produces a loud startup banner and hard-fails callback-wired runs at pickup with an explicit remedy; dev/Docker workflows keep the artifact fresh so the guard is a tripwire.

**Independent Test**: quickstart Scenario A — backdate/delete the artifact, start the worker: banner appears, callback-wired run → `failed` with the explicit error, mock run unaffected; `pnpm build:mcp-server` heals without worker restart.

### Tests for User Story 2 (write first, must fail) ⚠️

- [x] T010 [P] [US2] Unit tests in new `libs/executors/src/claude-cli/artifact-guard.spec.ts`: missing entry → `{ok:false, reason:'missing'}`; entry older than newest file in a nested src tree → `'stale'` with both mtimes; fresh → ok; src dir absent → `{ok:true, skipped:'no-src-dir'}`; `BRIGADIR_MCP_SERVER_ENTRY`/`BRIGADIR_MCP_SERVER_SRC` overrides honored; memo wrapper re-evaluates after its TTL
- [x] T011 [US2] Integration test in new `test/integration/artifact-guard.spec.ts`: scratch entry/src via env overrides + `utimes` — (a) stale artifact: callback-wired run finalizes `failed`, `error` names the artifact path and rebuild remedy, fake CLI never spawned, `attempt` reflects the single pickup; (b) mock/Phase-0 run with the same stale env runs normally (FR-015); (c) touch the entry file fresh → next callback-wired run completes the normal lifecycle (heal without restart; use a short memo TTL override)

### Implementation for User Story 2

- [x] T012 [US2] Extract path resolution into new `libs/executors/src/claude-cli/mcp-server-path.ts`: `resolveMcpServerEntryPath()` (moved verbatim from the private method at `libs/executors/src/claude-cli/claude-cli.executor.ts:381-384`, env `BRIGADIR_MCP_SERVER_ENTRY`) + new `resolveMcpServerSrcDir()` (env `BRIGADIR_MCP_SERVER_SRC`, default `<cwd>/packages/mcp-server/src`); switch the executor to the shared import (no behavior change); export both from `libs/executors/src/index.ts`
- [x] T013 [US2] Implement new `libs/executors/src/claude-cli/artifact-guard.ts`: pure `checkMcpServerArtifact({entryPath, srcDir})` — stat entry (missing → violation), recursive newest-mtime walk of srcDir (absent → skip pass with `skipped:'no-src-dir'`), strict `mtime(entry) < newestSrc` ⇒ `'stale'` (research D2); plus `createMemoizedArtifactGuard(ttlMs = 10_000)` wrapper and `formatArtifactGuardError(verdict)` producing the banner text (path, both timestamps, remedy `pnpm build:mcp-server`)
- [x] T014 [P] [US2] Startup surface: new `apps/worker/src/artifact-guard.bootstrap.ts` — `OnApplicationBootstrap` provider logging the error-level banner on violation (worker still starts, Clarification Q1); register in `apps/worker/src/app.module.ts` providers
- [x] T015 [US2] Pickup surface in `apps/worker/src/claude-cli-run.processor.ts`: after `load()`, only when `loaded.useCallbackChannel === true`, consult the memoized guard; on violation → error log + `runs.finalizeStatus(runId, 'failed', { error: <banner text> })` + `afterFinalize` + return (run is `queued`, nothing else owns it — research D1); placed BEFORE `checkExecutorGate`/`markRunning` so no attempt is consumed elsewhere
- [x] T016 [P] [US2] Build wiring in root `package.json`: `"start:worker": "pnpm build:mcp-server && node dist/apps/worker/main.worker.js"` (research D3; root `build` and the Docker image already chain the mcp-server build — verify, no change expected)

**Checkpoint**: quickstart Scenario A passes end-to-end; SC-001 satisfied

---

## Phase 5: User Story 3 — Orphaned reports rescued retroactively (Priority: P3)

**Goal**: a 60-second worker-side scan resolves every orphaned outbox file by run state (finalize / attach / discard / skip), idempotently and race-safely, with a 7-day retention for unresolvable files.

**Independent Test**: quickstart Scenario C — seed runs in every matrix state + files, call `OutboxReconcileService.run()` once → matrix outcomes; second call → zero writes; backdated file → deleted.

### Tests for User Story 3 (write first, must fail) ⚠️

- [x] T017 [P] [US3] Extend `libs/executors/src/claude-cli/outbox.spec.ts` for `listOutboxEntries`: missing dir → `[]`; non-`.json` and subdir entries ignored; returns `{runId (filename stem), filePath, mtime}` per file
- [x] T018 [US3] Integration test in new `test/integration/outbox-reconcile.spec.ts` (real PG/Redis, direct `OutboxReconcileService.run()` calls — no waiting on the 60 s tick): full resolution matrix from data-model.md — `running` → finalized with report outcome + `run_checks` + file consumed; `failed`+`outcome NULL` and `timed_out`+`outcome NULL` → same; terminal-with-outcome → file consumed, nothing written; `cancelled` → status untouched + one `undelivered_report` event (`source: 'periodic_reconcile'`) + consumed; `awaiting_human` → untouched AND file kept; unknown run id → consumed + logged; corrupt JSON → kept; second `run()` pass → zero additional DB writes (SC-005); corrupt file backdated 8 days → deleted on next pass (retention); scheduler idempotence — booting `WorkerAppModule` twice yields one `outbox-reconcile` job scheduler

### Implementation for User Story 3

- [x] T019 [P] [US3] Extend `libs/executors/src/claude-cli/outbox.ts`: `outboxDirPath(configRoot)` + `listOutboxEntries(configRoot): Promise<{runId, filePath, mtime}[]>` (readdir + stat, missing dir → `[]`, never throws) per `contracts/outbox-protocol.md`
- [x] T020 [P] [US3] Add `OUTBOX_RECONCILE_QUEUE = 'outbox-reconcile'` to `libs/queues/src/queue.constants.ts`, include in `allQueues` in `libs/queues/src/queues.module.ts` (composition-time queue name = sanctioned static structure — document at call site per constitution), update `libs/queues/src/queues.module.spec.ts`
- [x] T021 [US3] Implement new `apps/worker/src/outbox-reconcile.service.ts`: one `run()` pass per research D6 — `listOutboxEntries(defaultMcpConfigRoot(tmpdir()))`, per-file run lookup, resolution matrix (parse + `scrubAgentReport` + `finalizeWithReport`; on flip → `PipelineService.onRunFinished`; `cancelled`/`superseded` → `attachUndeliveredReport(..., 'periodic_reconcile')`; `awaiting_human`/`queued` → skip+keep; unknown/finalized → consume+log), warn-once in-memory set for unresolvable files, 7-day mtime retention sweep
- [x] T022 [US3] Scheduling: new `apps/worker/src/outbox-reconcile.processor.ts` (`@Processor(OUTBOX_RECONCILE_QUEUE)` → `service.run()`) and `apps/worker/src/outbox-reconcile.scheduler.ts` (`onApplicationBootstrap`: `upsertJobScheduler('outbox-reconcile', { every: 60_000 })`, idempotent by id — mirror `apps/worker/src/reconcile.scheduler.ts`); register both + the service in `apps/worker/src/app.module.ts`

**Checkpoint**: quickstart Scenario C passes; worker-death leg of SC-002 covered (rescue ≤ 2 ticks)

---

## Phase 6: User Story 4 — Dead channel detected before spawning (Priority: P4)

**Goal**: callback-wired runs probe `GET /api/callbacks/health` before spawning; dead channel ⇒ hold via the rate-limit path (no spawn, no attempt), `channel_down` run-events with exponential backoff and an error-level alert at 3 consecutive failures; recovery is automatic.

**Independent Test**: quickstart Scenario D — dead port ⇒ run stays `queued` with accumulating `channel_down` events and no fake-CLI side effects; stub 200 server ⇒ run completes; Phase-0 run ignores the dead URL entirely.

### Tests for User Story 4 (write first, must fail) ⚠️

- [x] T023 [P] [US4] Unit tests in new `apps/worker/src/channel-probe.spec.ts`: TTL ladder `30s → 60s → 120s → … cap 300s` (data-model pre-flight table); counter resets on success; alert flag at `consecutive >= 3`; health URL derivation from `BRIGADIR_CALLBACK_BASE_URL` (lazy env read) incl. the default base
- [x] T024 [US4] Integration test in new `test/integration/preflight-channel.spec.ts`: (a) `BRIGADIR_CALLBACK_BASE_URL` → closed port, enqueue callback-wired run → fake CLI never spawned, run stays `queued`, `runs.attempt` unchanged, `channel_down` events accumulate with growing `consecutive`/`retry_in_ms` (use a small TTL override for test speed); (b) bind a stub 200 server on the port → held run proceeds and completes normally with full attempt budget (SC-004); (c) Phase-0 mock run with the same dead URL executes normally (FR-015); (d) `GET /api/callbacks/health` on the booted backend returns 200 `{status:'ok'}` with no auth header
- [x] T025 [P] [US4] Contract test for the health endpoint in `libs/callback/src/callback-health.controller.spec.ts`: 200 static body, no `RunTokenGuard`, no DB access (per `contracts/callback-health.md`)

### Implementation for User Story 4

- [x] T026 [P] [US4] New `libs/callback/src/callback-health.controller.ts`: `@Controller('api/callbacks')` `@Get('health')` → `{ status: 'ok' }`, NO guard, no dependencies; register in `libs/callback/src/callback.module.ts` (additive — guarded `api/callbacks/runs/:runId` surface untouched, FR-016)
- [x] T027 [US4] New `apps/worker/src/channel-probe.ts`: `ChannelProbe` with `probe()` (`fetch(<base>/health, { signal: AbortSignal.timeout(2000) })`, alive ⇔ 2xx), in-memory per-run consecutive counters, `ttlFor(consecutive)` ladder, and `recordFailure(db, runId, ...)` writing the `channel_down` run-event per `contracts/run-event-types.md`; warn log <3, error log ≥3 (Clarification Q3)
- [x] T028 [US4] Pickup wiring in `apps/worker/src/claude-cli-run.processor.ts`: for `loaded.useCallbackChannel === true` only, after the artifact guard (T015) and BEFORE `checkExecutorGate`/`markRunning`: probe; on dead → record failure + `await this.worker.rateLimit(ttl)` + `throw Worker.RateLimitError()` (run stays `queued`, attempt not consumed — same mechanics as the executor gate); on alive → reset counter, proceed
- [x] T029 [P] [US4] Dashboard presenter for `channel_down` in `apps/web/src/components/RunTimeline/presenter.ts` (card «Канал недоступен», consecutive count + retry-in; error accent at `consecutive >= 3`) and icon in `apps/web/src/components/RunTimeline/RunTimeline.vue` (static lucide icon)

**Checkpoint**: quickstart Scenario D passes; 2026-07-19 replay: run held, not burned (SC-004)

---

## Phase 7: Polish & Cross-Cutting

- [x] T030 [P] Update `docs/architecture.md`: §4 AgentExecutor — deployment guard (hybrid surface), pre-flight probe + hold, periodic outbox reconciler; §5 callback protocol — health endpoint, outbox lifecycle/retention and the two new run_event types (§3 untouched — no schema change)
- [x] T031 [P] Append the iteration entry to `docs/progress.md` (feature 026: what shipped, incident linkage 2026-07-19 / run `3f60c1a1`, deviations: superseded grouped with cancelled, jitter dropped — research D6)
- [x] T032 Full gate + quickstart validation: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` all green (SC-007); walk quickstart Scenarios A–D manual smokes; confirm Phase-0 suites pass unmodified (SC-006)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: none
- **Foundational (P2)**: after Setup. Blocks **US1 and US3 only** (shared scrub helper + attach helper). US2/US4 can start right after Setup.
- **US1 (P3)**: after T002–T003
- **US2 (P4)**: after T001 — fully independent
- **US3 (P5)**: after T002–T003; reuses `undelivered_report` presenter from US1 T009 (if US3 lands first, pull T009 into its scope)
- **US4 (P6)**: after T001 — independent; T028 notes an ordering interaction with T015 (guard before probe) but compiles without it
- **Polish (P7)**: after all desired stories

### File-conflict note (single shared hot file)

`apps/worker/src/claude-cli-run.processor.ts` is edited by T006/T007/T008 (US1), T015 (US2), T028 (US4). The stories stay independently mergeable, but if worked in parallel, land these edits sequentially (rebase order US1 → US2 → US4 recommended — matches branch-priority). The `kimi` processor subclass inherits all of it automatically — no separate task.

### Within each story

Tests first (fail) → lib-level pure code → worker wiring → UI presenter. `[P]` tasks touch disjoint files.

## Parallel Example: after Setup completes

```text
Track A (dev 1): T002 → T003 → US1 (T004…T009)
Track B (dev 2): T010 → T011 → US2 (T012…T016)   # no Foundational dependency
Track C (dev 3): T023 → T025 → T026/T027          # US4 lib/controller parts
# Processor wiring tasks (T006-8, T015, T028) serialize on claude-cli-run.processor.ts
```

## Implementation Strategy

**MVP = Phase 1 + 2 + US1** (T001–T009): the `3f60c1a1` verdict-loss becomes impossible at completed-exit — highest value, smallest diff. Validate via quickstart Scenario B, ship as one PR.

Then incrementally: **US2** (guard — makes every other net trustworthy), **US3** (worker-death coverage), **US4** (waste prevention), each as its own independently green PR (`pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` per PR — constitution Development Workflow), Polish last.

---

## Implementation notes (2026-07-21)

- **All 32 tasks implemented; gates green.** Unit: `pnpm typecheck && pnpm lint && pnpm test` (459 unit tests). Integration (real PG/Redis, Docker): the four feature-026 suites pass 12/12 — `artifact-guard.spec.ts`, `claude-cli-exit-reconcile.spec.ts`, `outbox-reconcile.spec.ts`, `preflight-channel.spec.ts`.
- **Deviation (T004/T005):** US1 exit-time coverage lives in a dedicated new spec `test/integration/claude-cli-exit-reconcile.spec.ts` (its own scratch config-root + fresh-artifact/backend setup) instead of extending `claude-cli-lifecycle.spec.ts` — cleaner isolation, equivalent coverage.
- **Config-root centralization (beyond the literal task list):** added `resolveMcpConfigRoot()` (env `BRIGADIR_MCP_CONFIG_ROOT`) as the single writer/reader source of truth, so the periodic reconciler is hermetically testable and cannot scan a concurrent suite's outbox files.
- **`RunsService.reconcileWithReport` (new):** the periodic reconciler needed to rescue terminal-bad runs (`failed`/`timed_out` with `outcome IS NULL`), which `finalizeWithReport`'s active-only guard cannot flip; the widened guard stays race-safe via the flipped flag.
- **Build wiring:** `start:worker` AND `test:integration` build the mcp-server artifact first, so the guard is satisfied in dev/CI (Docker image already did via `pnpm build`).
- **Pre-existing, non-feature failures** (`serve-static`, `sprint-sequencing`, `runs-cancel-all`, `dependency-gate`) fail identically on the clean base — environmental (web bundle not built, Jira-mock timing), not regressions.

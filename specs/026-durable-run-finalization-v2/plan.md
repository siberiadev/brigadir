# Implementation Plan: Durable Run Finalization v2 — Deployment Guard + Outbox Safety Net

**Branch**: `026-durable-run-finalization-v2` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/026-durable-run-finalization-v2/spec.md`

## Summary

Close the four gaps that let run `3f60c1a1` lose a computed verdict:
(A) a **deployment guard** that detects a missing/stale
`packages/mcp-server/dist/main.js` — loud error at worker startup, hard-fail
of callback-wired runs at pickup (hybrid surface per Clarifications Q1), with
build wiring so it almost never fires; (B) **widened exit-time reconcile** in
`ClaudeCliRunProcessor` — the `completed`-exit fail-closed branch reads the
outbox before `failIfStillRunning`, and `cancelled` stops attach the report
as an `undelivered_report` run-event instead of discarding it; (C) a
**periodic outbox reconciler** (BullMQ job scheduler, every 60 s, same
pattern as `ReconcileScheduler`) that rescues orphaned outbox files by run
state; (D) a **pre-flight channel probe** against a new unauthenticated
`GET /api/callbacks/health` — dead channel ⇒ hold via the existing
`worker.rateLimit()` path with a `channel_down` run-event, no attempt burned.
All finalizes go through the existing status-guarded `finalizeWithReport`
(CLAUDE.md rule 7); all persisted report content passes the scrubber
(Constitution V — this also closes a pre-existing gap in the timed_out
reconcile). No DB schema changes: `run_events.type` is free text.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true` (Node 22, ES2023)

**Primary Dependencies**: NestJS 11 (backend + WorkerHost worker), BullMQ 5
(job scheduler for the periodic reconciler), Drizzle ORM, zod
(`ReportSchema` in `packages/contracts`). **No new external dependencies.**

**Storage**: Postgres 16 (runs, run_events — no schema change; `run_events.type`
is a free-text column). Filesystem: outbox dir
`<defaultMcpConfigRoot(os.tmpdir())>/.brigadir-outbox/*.json`. Redis holds
only the BullMQ scheduler/queues (nothing durable).

**Testing**: vitest unit tests (guard decision logic, probe backoff, outbox
listing/retention); vitest + testcontainers integration tests against real
Postgres/Redis (`test/integration`, shared containers via `global-setup.ts`,
per-suite isolation via unique `BULLMQ_PREFIX` — never `flushdb`).

**Target Platform**: Linux/macOS server (worker + backend processes; single
docker image built by root `pnpm build`)

**Project Type**: pnpm monorepo — NestJS apps (`apps/worker`,
`apps/backend`), shared libs (`libs/executors`, `libs/runs`,
`libs/callback`, `libs/queues`, `libs/scrubber`), artifact package
(`packages/mcp-server`), Vue dashboard (`apps/web`)

**Performance Goals**: reconciler scan of a near-empty dir every 60 s
(negligible); artifact guard ≤ a few ms (stat walk of ~15 source files,
memoized 10 s); probe adds ≤ 2 s (timeout) to callback-wired run pickup only

**Constraints**: process-outcome writes guarded `WHERE status='running'`
(rule 7); no resource init in `@Module()` args (rule 1); Phase-0 runs
byte-identical; callback HTTP API contract unchanged (health endpoint
additive); phases A–D independently mergeable

**Scale/Scope**: internal tool, single worker instance; ≤ dozens of runs/day;
outbox dir holds at most a handful of files

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-Phase-1 design. Constitution v1.2.0.*

| Principle | Verdict | Notes |
|-----------|---------|-------|
| I. Dual Source of Truth | ✅ PASS | The outbox file is a delivery buffer for an already-authored report, never a third source of truth: every decision (finalize / attach / discard / skip) is driven by the run row's current Postgres status, and the file never overrides it. Redis gains only a job scheduler entry (transient). |
| II. Idempotency at Three Levels | ✅ PASS | No new run-triggering path is added. The pre-flight hold reuses `worker.rateLimit()` + `Worker.RateLimitError()` (job returns to waiting, attempt not consumed — same as the executor gate). Reconciler finalizes are idempotent via the guarded UPDATE + `flipped` flag; a consumed file cannot be reprocessed. |
| III. System-Only Jira Writes | ✅ PASS | Reconcile finalizes call `RunsService.finalizeWithReport` then `PipelineService.onRunFinished` — the exact post-callback path; all Jira writes stay behind the per-issue write queue. No new Jira write site. |
| IV. Run Completion Contract | ✅ PASS (see note) | The 1.2.0 amendment forbids a *structured-output* rescue path (report-shaped stdout). The outbox is not that: it is the same `complete_task` report authored through the callback tool, persisted by the tool server when HTTP delivery fails — deferred delivery of the single completion channel (established by the merged Phase-4 fix; this feature only widens where it is read). Runs with no schema-valid report anywhere still fail closed (FR-007). Repeated finalize attempts remain rejected by the status guard. |
| V. Secret Isolation & Output Scrubbing | ✅ PASS (action) | Every outbox report is scrubbed before persistence: `scrubAgentReport` is extracted from `callback.service.ts` into an exported helper and applied on ALL reconcile paths — including the existing timed_out reconcile, which currently bypasses scrubbing (pre-existing gap, fixed here). `undelivered_report` payloads persist only schema-valid, scrubbed reports. The health endpoint returns a static liveness body — nothing sensitive, no DB data. Guard/probe touch no secrets. |
| VI. Test-Mandatory Pipeline Logic | ✅ PASS | All four parts are pipeline logic → unit + integration tests land in the same iteration (see quickstart.md for the scenario matrix). Idempotency scenarios (double reconcile, reconcile vs live callback race) are explicitly tested. |
| Tech: Lazy resource resolution | ✅ PASS | Scheduler registered in `onApplicationBootstrap` via `upsertJobScheduler` (existing `ReconcileScheduler` precedent); queue name added at composition time is static structure (documented at the call site, per the rule's carve-out). Probe URL read lazily from `process.env.BRIGADIR_CALLBACK_BASE_URL` at run pickup. No new connections at module composition. |
| Tech: fixed stack | ✅ PASS | Node `fs/promises` stat walk, global `fetch` with `AbortSignal.timeout` — stdlib only. |

**Post-Phase-1 re-check (2026-07-21)**: design artifacts introduce no schema
change, no new completion channel, no new Jira write site, no eager resource
init. Gate remains PASS; Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/026-durable-run-finalization-v2/
├── plan.md              # This file
├── research.md          # Phase 0 output — decisions D1–D12
├── data-model.md        # Phase 1 output — entities, event types, state matrix
├── quickstart.md        # Phase 1 output — validation scenarios
├── contracts/
│   ├── callback-health.md    # GET /api/callbacks/health (additive)
│   ├── outbox-protocol.md    # on-disk file contract + resolution matrix
│   └── run-event-types.md    # undelivered_report / channel_down payloads
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
libs/executors/src/claude-cli/
├── mcp-server-path.ts        # NEW: shared resolveMcpServerEntryPath()/resolveMcpServerSrcDir()
│                             #   (extracted from claude-cli.executor.ts private method;
│                             #    env overrides BRIGADIR_MCP_SERVER_ENTRY / _SRC)
├── artifact-guard.ts         # NEW (A): checkMcpServerArtifact() pure decision + 10s memo wrapper
├── artifact-guard.spec.ts    # NEW: unit tests (missing/stale/fresh/no-src-dir/override)
├── outbox.ts                 # EXTEND (C): listOutboxEntries(), outboxDirPath(), mtime exposure
├── outbox.spec.ts            # EXTEND: listing + malformed-file cases
└── claude-cli.executor.ts    # EDIT: use shared mcp-server-path resolver (no behavior change)

libs/callback/src/
├── report-scrub.ts           # NEW: export scrubAgentReport() (moved from callback.service.ts)
├── callback.service.ts       # EDIT: import scrubAgentReport from report-scrub
├── callback-health.controller.ts  # NEW (D): @Controller('api/callbacks') @Get('health'), no guard
└── callback.module.ts        # EDIT: register health controller

libs/queues/src/
├── queue.constants.ts        # EDIT: + OUTBOX_RECONCILE_QUEUE = 'outbox-reconcile'
└── queues.module.ts          # EDIT: + queue in allQueues (static structure, documented)

apps/worker/src/
├── artifact-guard.bootstrap.ts   # NEW (A): OnApplicationBootstrap — startup check, error-level log
├── channel-probe.ts              # NEW (D): probe(baseUrl), per-run consecutive counters,
│                                 #   backoff TTL (30s ·2ⁿ, cap 5min), channel_down event writer
├── channel-probe.spec.ts         # NEW: unit tests (backoff, counter reset, alert threshold 3)
├── outbox-reconcile.service.ts   # NEW (C): one scan pass — resolution matrix + retention
├── outbox-reconcile.processor.ts # NEW (C): @Processor(OUTBOX_RECONCILE_QUEUE) → service.run()
├── outbox-reconcile.scheduler.ts # NEW (C): upsertJobScheduler('outbox-reconcile', {every: 60_000})
├── claude-cli-run.processor.ts   # EDIT (A,B,D): guard check + probe before markRunning;
│                                 #   completed-exit outbox reconcile; cancelled → attach event
└── app.module.ts                 # EDIT: register new providers

apps/web/src/components/RunTimeline/
├── presenter.ts              # EDIT: presenters for 'undelivered_report' & 'channel_down'
└── RunTimeline.vue           # EDIT: icons/accents for the two new types

package.json                  # EDIT (A): start:worker chains build:mcp-server
docs/architecture.md          # EDIT: §4 (guard, probe, reconciler), §5 (health endpoint,
                              #   outbox lifecycle); §3 untouched — no schema change

test/integration/
├── outbox-reconcile.spec.ts      # NEW (C): resolution matrix against real PG/Redis
├── preflight-channel.spec.ts     # NEW (D): dead channel → hold, no spawn, no attempt;
│                                 #   recovery → normal run; Phase-0 unaffected
├── artifact-guard.spec.ts        # NEW (A): stale/missing artifact → run fails with explicit
│                                 #   error; fresh → normal; mock runs unaffected
└── claude-cli-lifecycle.spec.ts  # EXTEND (B): completed-exit rescue; cancelled → attach
```

**Structure Decision**: pure decision logic lives in `libs/executors`
(guard, outbox listing) and `libs/callback` (scrub extraction, health
controller) so it is unit-testable and reusable by both worker processors
(`claude_cli` + the `kimi` subclass inherit the widened `process()`
automatically). Worker-only orchestration (scheduler, processor wiring,
probe counters) lives in `apps/worker`, mirroring the existing
`ReconcileScheduler`/`ReconcileProcessor` split. No changes to
`packages/mcp-server` (writer side is already correct post-P0/Phase-4).

## Complexity Tracking

No constitution violations — table intentionally empty.

## Phase Mapping (for /speckit-tasks)

Independently mergeable slices, in dependency order:

1. **Slice A — guard + build wiring**: `mcp-server-path.ts`,
   `artifact-guard.ts` (+unit), `artifact-guard.bootstrap.ts`, pickup check
   in the run processor, `package.json` chain, integration suite. No
   dependency on B/C/D.
2. **Slice B — exit-time widening**: `report-scrub.ts` extraction (+ scrub
   retrofit of the existing timed_out reconcile), completed-exit rescue,
   cancelled-attach (`undelivered_report` event), lifecycle-suite cases.
3. **Slice C — periodic reconciler**: outbox listing helpers, queue
   constant, service/processor/scheduler, retention policy, integration
   suite, web presenter for `undelivered_report` (shared with B — land with
   whichever merges first).
4. **Slice D — pre-flight probe**: health controller, `channel-probe.ts`
   (+unit), pickup wiring, `channel_down` presenter, integration suite.

B/C/D depend on A only operationally (fresh artifact at runtime), not at
compile time. B and C share `report-scrub.ts` and the `undelivered_report`
event contract — whichever lands second reuses, not duplicates.

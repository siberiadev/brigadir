# Implementation Plan: Callback-Channel Resilience Ops — Stable Agent-Serving Runtime + Channel-Health Observability

**Branch**: `027-callback-channel-resilience` | **Date**: 2026-07-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/027-callback-channel-resilience/spec.md`

## Summary

Close the two post-incident gaps left after durable-finalize v2: (A) decouple
the callback target from the human's editor by scripting a second, non-watch
native backend+worker pair on a dedicated port (`scripts/agents-mode.mjs`,
`agents:start|stop|status`), with a Redis-held exclusive worker lock so two
workers can never silently consume the same queues; (B) make failed callback
deliveries durable and visible — the mcp-server appends summary breadcrumbs to
`.brigadir-channel/<runId>.jsonl` on retry exhaustion, the worker ingests them
as `channel_failure` run-events at run exit and via the periodic reconciler;
(C) surface channel health to the operator — an additive
`GET /api/channel-health` aggregate (last successful callback, windowed
failure/probe counts, deployment-guard verdict) driving a global sidebar
indicator with degraded state and click-through, plus a `callback_alert`
marker on the runs list. Full design rationale: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript strict, Node ≥ 22 (`--env-file` relied on), pnpm 9.15

**Primary Dependencies**: NestJS 11 (backend + worker WorkerHost), BullMQ 5 + ioredis, Drizzle/Postgres 16, Vue 3 + Element Plus + TanStack Query, zod (`@brigadir/contracts`), `@modelcontextprotocol/sdk` (mcp-server). **No new external dependencies** (mode script is plain Node; lock uses the existing ioredis connection).

**Storage**: Postgres `run_events` (free-text `type`; new value `channel_failure`) — **no schema change, no migration**. Filesystem: `<configRoot>/.brigadir-channel/<runId>.jsonl` beside the 026 outbox. Redis: BullMQ queues + the transient worker lock key (`${prefix}:worker-lock`).

**Testing**: vitest unit (colocated `src/**/*.spec.ts`; mcp-server real-fetch contract suite extended), vitest + testcontainers integration (`test/integration/`, shared containers, unique `BULLMQ_PREFIX` per suite, never `flushdb`), web component tests (jsdom + msw + `mountWithProviders`).

**Target Platform**: operator's macOS/Linux host (self-hosted internal tool); both stacks run from built bundles on the same machine, sharing `.env`, Postgres, Redis, and the mcp-config root.

**Project Type**: pnpm monorepo — NestJS monorepo apps (`apps/backend`, `apps/worker`) + Vue SPA (`apps/web`) + libs (`libs/*`) + packages (`packages/contracts`, `packages/mcp-server`).

**Performance Goals**: health endpoint cheap enough for 5 s dashboard polling (two windowed `run_events` count queries + memoized artifact stat); lock takeover ≤ lock TTL (15 s default); double-worker error surfaced within ~2 s (acquire-loop cadence); indicator reflects evidence within one 5 s polling interval (SC-004).

**Constraints**: existing callback HTTP endpoints untouched; Jira write path untouched; Phase-0 runs (`useCallbackChannel=false`) byte-for-byte unchanged; breadcrumb writer best-effort/never-throws; all new env read lazily with documented defaults (no silent localhost fallbacks for connections); phases A/B/C independently mergeable, B before C.

**Scale/Scope**: single operator, one machine, two process pairs; run_events at internal-tool volume (window scans acceptable without new indexes); ~6 new source modules + ~10 touched files + ~10 new test suites.

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-Phase-1 design — **PASS** (no violations, no Complexity Tracking entries).*

| Principle | Verdict | Notes |
|---|---|---|
| I. Dual Source of Truth | PASS | Breadcrumb evidence becomes durable in Postgres (`run_events`); the JSONL file is a transit buffer, consumed on ingestion. The Redis lock is coordination (a transient flag), never durable state. Health aggregate is derived on demand, stored nowhere. |
| II. Idempotency at Three Levels | PASS | No new run-triggering path. The lock adds a *fourth* guard against double consumption without weakening the three existing layers; `maxStalledCount: 0` and `runs_one_active` untouched. |
| III. System-Only Jira Writes | PASS | No Jira interaction anywhere in this feature. |
| IV. Run Completion Contract | PASS | Breadcrumb ingestion never writes run status or outcome (only `run_events`); finalization/rescue paths from 026 unchanged. Degraded health is observability-only — admission stays with the pre-flight probe. |
| V. Secret Isolation & Output Scrubbing | PASS | Breadcrumbs record error name/message + target host:port only — never headers, tokens, URLs with query, or payloads; `error.message` passes the secret scrubber before DB insert. Mode script passes secrets via `--env-file`, never argv. |
| VI. Test-Mandatory Pipeline Logic | PASS | Lock, ingestion (both paths + race), health aggregation, and list projection all ship with unit + integration tests in the same iteration (research.md R7); UI ships component tests. |
| Tech constraint: lazy resource resolution | PASS | Lock TTL/mode, health window/threshold, agents port — all read lazily at use sites with inline documented defaults (ChannelProbe precedent); nothing evaluated in `@Module()` args. |

## Project Structure

### Documentation (this feature)

```text
specs/027-callback-channel-resilience/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1–R7
├── data-model.md        # Phase 1 — entities, payloads, config surface
├── quickstart.md        # Phase 1 — validation scenarios (incl. SC-001 drill)
├── contracts/
│   ├── channel-breadcrumbs.md   # JSONL record + dir protocol + ingestion rules
│   ├── channel-health-api.md    # GET /api/channel-health + runs-list field
│   └── worker-lock.md           # lock key/TTL/renewal/takeover semantics
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
scripts/
└── agents-mode.mjs                      # NEW (A): start|stop|status, pidfiles/logs in .agents-mode/

package.json                             # (A) agents:start/stop/status scripts; .gitignore: .agents-mode/
docs/local-setup.md                      # (A) new §2a «Стабильный режим для агентов»
.env.example                             # (A,C) BRIGADIR_AGENTS_PORT, BRIGADIR_WORKER_MODE,
                                         #       BRIGADIR_WORKER_LOCK_TTL_MS,
                                         #       BRIGADIR_CHANNEL_HEALTH_WINDOW_MS, _FAILURE_THRESHOLD

apps/worker/src/
├── worker-lock.service.ts               # NEW (A): acquire/renew/release, contender key, pause/resume gating
├── worker-lock.bootstrap.ts             # NEW (A): pauses WorkerHost workers until lock held
├── channel-breadcrumb-ingest.ts         # NEW (B): claim→parse→scrub→insert channel_failure rows
├── claude-cli-run.processor.ts          # (B) ingest call at every terminal branch (callback-wired)
├── outbox-reconcile.service.ts          # (B) second scan: .brigadir-channel/*.jsonl, terminal runs only
└── app.module.ts                        # register new providers

packages/mcp-server/src/
├── channel-breadcrumbs.ts               # NEW (B): appendChannelBreadcrumb (best-effort, 64 KB cap)
└── tools.ts                             # (B) onExhausted hook at both budget-exhaustion branches

libs/executors/src/claude-cli/
└── channel-breadcrumbs.ts               # NEW (B): dir/list/claim(rename)/read/consume helpers

packages/contracts/src/
├── channel.schema.ts                    # NEW (B,C): breadcrumb record, channel_failure payload,
│                                        #            ChannelHealthResponseSchema
└── runs.schema.ts                       # (C) RunListItemSchema + callback_alert: boolean

apps/backend/src/dashboard/
├── channel-health.controller.ts         # NEW (C): GET /api/channel-health (DashboardTokenGuard)
├── channel-health.service.ts            # NEW (C): window counts, guard verdict, affected runs
├── runs.controller.ts                   # (C) callback_alert EXISTS projection in list query
└── dashboard.module.ts                  # register controller/service

libs/callback/src/callback.service.ts    # (C) progress event payload + via: 'callback' (additive)

apps/web/src/
├── api/channelHealth.ts                 # NEW (C)
├── composables/useChannelHealth.ts      # NEW (C): 5 s poll, placeholderData
├── components/ChannelHealthIndicator.vue# NEW (C): sidebar-bottom icon + popover
├── components/AppSidebar.vue            # (C) mount indicator
├── components/RunTimeline/presenter.ts  # (B-UI) channel_failure case
├── components/RunTimeline/TimelineEvent.vue # (B-UI) Unplug icon, danger accent
└── views/Runs.vue                       # (C) callback_alert marker in status cell

test/integration/
├── worker-lock.spec.ts                  # NEW
├── channel-breadcrumbs.spec.ts          # NEW
└── channel-health.spec.ts               # NEW
(+ colocated unit specs next to each new module; web specs in apps/web/test/)
```

**Structure Decision**: no new apps/libs/packages — every piece lands in an
existing home following its nearest 026 precedent (probe → worker service,
outbox → executors lib helpers + mcp-server writer, dashboard endpoint →
dashboard module, timeline type → presenter). The only net-new directory is
`scripts/` (first operational script; npm-scripts convention kept as the
entry point).

## Phase boundaries (independently mergeable)

- **A (runtime mode + lock)**: `scripts/agents-mode.mjs`, npm scripts,
  `worker-lock.*`, docs §2a, `.env.example`; integration `worker-lock.spec`.
  Verifies FR-001…FR-006, SC-001, SC-002.
- **B (breadcrumbs end-to-end)**: mcp-server writer + hook, executors
  helpers, worker ingest (exit + reconciler), `channel.schema.ts` (record +
  payload), presenter/TimelineEvent rendering; unit + integration +
  component tests. Verifies FR-007…FR-011, SC-003.
- **C (health surface)**: endpoint + service, `ChannelHealthResponseSchema`,
  `callback_alert` projection + list UI, indicator + composable, `via:
  'callback'` tag; integration + component tests. Verifies FR-012…FR-016,
  SC-004, SC-006. **Depends on B's event type** (merge after B).

## Complexity Tracking

> No constitution violations — table intentionally empty.

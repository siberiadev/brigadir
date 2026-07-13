# Implementation Plan: Runs Visibility & Human Queue

**Branch**: `006-runs-human-queue` | **Date**: 2026-07-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-runs-human-queue/spec.md`

## Summary

Deliver the **operational half** of the dashboard so an operator can, without touching the DB
or Jira: clear a unified **needs-human queue** (US1), read an agent's report as a scannable
**checklist** and diagnose a run from a **run/ticket card** (US2), **browse/filter runs** in a
workspace with a lite cost figure (US3), **administer executors** with typed per-type config +
default seeding so the picker is never empty (US4, iteration-5 debt), and poll **every enabled
workspace** with per-workspace Jira clients and outage isolation (US5, iteration-5 debt).
This closes product pains **#2** (unreadable reports) and **#3** (no needs-human queue).

The pipeline and callback protocol are untouched (FR-033): every write is a **read
projection**, a **guarded status flip** (cancel), or a call to an **existing** path (retry →
manual-trigger, resume → feature-004 `ResumeService`). **No structural schema change** — all
data already exists in architecture §3. Two additive, non-structural items only: a supporting
index for the workspace-scoped runs read, and a jsonb-embedded `settings.enabled` pause flag
(the spec's assumed `enabled` column **does not exist** — resolved in research R3 without DDL).
Live updates use **client-side polling** (TanStack Query `refetchInterval`), the simplest
mechanism that meets "within a few seconds" and reuses the existing bearer auth path with no
token in any URL (research R1).

## Technical Context

**Language/Version**: TypeScript strict (Node ≥22); Vue 3 SFCs for the frontend.

**Primary Dependencies**: Backend/worker — NestJS 11, Drizzle (Postgres 16), BullMQ 5,
existing `JiraClientFactory` (per-workspace, fingerprint-cached, 005 R6). Frontend — Vue 3,
Vite, Element Plus, Pinia, `@tanstack/vue-query` (`refetchInterval` for live updates), Vue
Router. Shared — `@brigadir/contracts` (zod, single typed source).

**Storage**: Postgres 16 — existing `runs`, `run_checks`, `run_events`, `human_tasks`,
`executors`, `tickets`, `workspaces`. **No new table, no new column.** One additive index
(`runs_workspace_created`); pause flag in `workspaces.settings` jsonb.

**Testing**: Vitest everywhere. Backend/worker — testcontainers (real Postgres/Redis) +
mock-jira, no broker mocks, per-suite `BULLMQ_PREFIX`. Frontend — Vitest + `@vue/test-utils`
+ jsdom + msw component tests extending `apps/web/test/{mount,handlers}.ts`.

**Target Platform**: Self-hosted single node; `docker compose` (postgres, redis, backend,
worker); backend serves the built SPA.

**Project Type**: Web application — `apps/web` (Vue SPA) + `apps/backend` + `apps/worker` in
the pnpm monorepo, shared `packages/contracts` + `libs/*`.

**Performance Goals**: Operator-facing, not throughput-bound. Live surfaces refresh in 3–5 s
(polling). Runs table reads ride the new `(workspace_id, created_at desc)` index. Concurrency
re-apply lag ≤ ~15 s.

**Constraints**: Constitution v1.2.0 — system-only Jira writes; run/callback protocol frozen
(FR-033); outcome-derived status writes guarded to `WHERE status='running'` (rule #7, the
cancel guard); lazy resource resolution (per-workspace Jira client resolved in a DI factory at
pass time, never at composition); tests same-iteration for pipeline logic; suite isolation by
`BULLMQ_PREFIX`. No bearer in any URL (privacy rule → polling, not raw SSE).

**Scale/Scope**: Small trusted team, single shared bearer, no RBAC. Multi-workspace becomes
real (US5). ~4 operator surfaces (human queue, run card, runs table, executors admin) + the
worker reconcile refactor.

## Constitution Check

*GATE: re-checked after Phase 1 design. Result: **PASS** (initial and post-design).*

| Principle | Assessment |
|-----------|------------|
| I. Dual Source of Truth | Jira stays the ticket-status authority; the card/table/queue are **projections of Postgres** run history (the sanctioned authority for runs/checks/events/human-tasks). No third source, no board copy (FR-034). `last_seen_status` untouched. ✅ |
| II. Idempotency (3 levels) | Retry reuses `RunTriggerService.trigger` → all three layers; a second active run is refused by `runs_one_active` and surfaced as `409` (not bypassed). Resume reuses feature-004 `ResumeService` (guarded supersede+insert). No new trigger path escapes the layers. ✅ |
| III. System-only Jira writes | This feature writes **nothing** to Jira. It reads Jira only indirectly (deep links are built from stored `jira_site_url`+`jira_key`; no live call). Resume's running-status transition is the existing feature-004 system write. ✅ |
| IV. Run Completion Contract | Not touched — no run/report/callback change (FR-033). The card only **reads** `report`/`run_checks`/`run_events`. ✅ |
| V. Secret Isolation & at-rest | Executor `secrets` are encrypted at rest and **never serialized** in any executors response. Per-workspace Jira client resolved via the existing fingerprint-cached factory (rotation-safe). Bearer never in a URL (polling). No new secret in a query string. ✅ |
| VI. Test-Mandatory Pipeline Logic | Multi-workspace reconcile, concurrency re-apply, executor CRUD + seeding + delete-guard, cancel guard, retry dedup, and resume are pipeline logic → integration tests (testcontainers + mock-jira) same-iteration. UI gets msw component tests for the queue, card, runs table, and executor form. ✅ |
| Tech constraints (lazy resolution) | `JiraClientFactory` injected into `ReconcileService` resolves per-workspace credentials **inside `forWorkspace`** at pass time (DI method call), never at `@Module()` composition. Concurrency re-apply reads the DB on a live timer, not at composition. ✅ |
| Rule #5 (schema unchanged w/o doc) | No column/table change. The one additive index is non-structural and committed as a reviewed migration; the pause flag is a jsonb value (no DDL). Architecture §3 unchanged. ✅ |
| Rule #7 (outcome writes guarded) | Cancel is `UPDATE … WHERE status='running'` — cannot overwrite `awaiting_human` (FR-012 / Edge Case "Cancel race"). ✅ |

**No violations → Complexity Tracking left empty.**

## Project Structure

### Documentation (this feature)
```text
specs/006-runs-human-queue/
├── plan.md                       # This file
├── research.md                   # R1 polling · R2 multi-ws reconcile · R3 enabled-flag (schema finding)
│                                 #   · R4 concurrency re-apply · R5 executors CRUD · R6 card · R7 table · R8 queue
├── data-model.md                 # Existing entities + NO structural change (1 index, 1 jsonb flag)
├── contracts/
│   ├── runs-api.md               # runs table, card, cost, cancel, retry
│   ├── human-queue-api.md        # queue list/count + guarding the existing resolve endpoint
│   ├── executors-api.md          # CRUD + typed per-type config + seeding + concurrency re-apply
│   └── reconcile-multiworkspace.md  # worker pass: all enabled workspaces, per-workspace client
├── quickstart.md                 # Scenarios A–E validation guide
└── tasks.md                      # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)
```text
packages/contracts/src/
├── runs.schema.ts                # NEW — runs list/card/cost response types
├── human-queue.schema.ts         # NEW — queue list/count types (resolve schema already exists)
├── executor.schema.ts            # NEW — discriminated-union per-type config (mock | claude_cli)
└── jira.types.ts                 # CHANGED — WorkspaceSettings.enabled?: boolean

apps/backend/src/dashboard/
├── runs.controller.ts            # NEW — GET runs, GET runs/cost, GET run, POST cancel, POST retry
├── human-tasks.controller.ts     # NEW — GET list, GET count (resolve stays in libs/human-tasks)
├── executors.controller.ts       # NEW — list/create/update/delete + seeding helper
├── workspaces.controller.ts      # CHANGED — seed executors on create; settings accepts enabled
└── dashboard.module.ts           # CHANGED — register new controllers + services

libs/human-tasks/src/
└── resolve.controller.ts         # CHANGED — apply DashboardTokenGuard (was unguarded)

libs/ingest/src/
├── reconcile.service.ts          # CHANGED — iterate enabled workspaces; per-workspace JiraClient
└── poller.service.ts             # CHANGED — pollAndDiff(ws, jira); drop @Inject(JIRA_CLIENT)
libs/ingest/src/*(watchdog|drift-repair).service.ts  # CHANGED if they call Jira — take (ws, jira)

libs/jira/src/jira.module.ts      # CHANGED — export JiraClientFactory to the worker provider set

apps/worker/src/
├── run.processor.ts              # CHANGED — periodic concurrency re-apply (mock)
├── claude-cli-run.processor.ts   # CHANGED — periodic concurrency re-apply (claude_cli)
└── executor-concurrency.ts       # reused as-is (sum per type; now called on an interval)

apps/web/src/
├── api/{runs,humanTasks,executors}.ts        # NEW — typed resource modules
├── composables/{useRuns,useRunCard,useHumanTasks,useExecutors}.ts  # NEW — Query hooks w/ refetchInterval
├── views/Runs.vue                # CHANGED — placeholder → real runs table + cost header
├── views/HumanQueue.vue          # CHANGED — placeholder → queue list + resolution actions + history
├── views/RunCard.vue             # NEW — report checklist + timeline + history + cancel/retry
├── views/WorkspaceSettings.vue   # CHANGED — Executors section + enabled/pause toggle
├── components/AgentForm/…        # CHANGED — executor picker reads /executors (names+badges, default claude_cli)
├── components/ExecutorForm/…     # NEW — typed per-type config form
├── App.vue / router              # CHANGED — navbar open-task badge; landing rule; run-card + settings routes
└── test/…                        # NEW — msw handlers + component tests (queue, card, table, executor form)

drizzle/                          # NEW migration — additive index runs_workspace_created (reviewed, committed)
```

**Structure Decision**: Existing monorepo web-app layout (feature 005). Backend gains a
`runs`/`human-tasks`/`executors` REST surface under the existing `dashboard/` module and
`DashboardTokenGuard`; the worker's `libs/ingest` reconcile loop is refactored to
multi-workspace with per-workspace Jira clients; the Vue SPA fills the placeholder Runs/
HumanQueue routes and adds the run card + executor admin. Shared request/response and the
typed executor config live in `packages/contracts` (single-typed-source rule).

## Phases

### Phase 0 — Research ✅ (`research.md`)
R1 live-update transport = **polling** · R2 multi-workspace reconcile + per-workspace client ·
R3 **schema finding**: no `enabled` column → `settings.enabled` (no DDL) · R4 live concurrency
re-apply (worker timer) · R5 executors CRUD + typed config + seeding + delete-guard · R6 card
read model + cancel/retry reuse · R7 runs table + supporting index + cost · R8 human queue +
guarding resolve. No open unknowns.

### Phase 1 — Design & Contracts ✅
`data-model.md` (entities + **no structural change** verdict; 1 additive index, 1 jsonb flag),
`contracts/` (runs, human-queue, executors, multi-workspace reconcile), `quickstart.md`
(Scenarios A–E). Agent context refreshed.

### Phase 2 — Implementation outline (for `/speckit-tasks`)
Dependency-ordered; contracts + iteration-5 debt (foundational) first, UI last:

1. **Contracts** — `runs.schema.ts`, `human-queue.schema.ts`, `executor.schema.ts` (typed
   union + unit tests), `WorkspaceSettings.enabled`.
2. **Executors backend (US4)** — `executors.controller` (CRUD, typed validation, delete-guard),
   default seeding wired into workspace create, `JiraClientFactory` export fix. Integration
   tests: seeding, CRUD, delete-in-use `409`, config validation matrix.
3. **Concurrency re-apply (US4/FR-025)** — periodic re-apply in both run processors (reuse
   `applyExecutorConcurrency`). Integration test: change limit → live `worker.concurrency`
   reflects the sum, no restart.
4. **Multi-workspace reconcile (US5)** — `ReconcileService` loop over enabled workspaces with
   per-workspace client; thread `jira` into poller/drift; two-layer isolation. Integration
   tests: two-enabled+one-disabled, outage isolation, per-workspace client, HWM per workspace.
5. **Runs + human-queue backend (US2/US3/US1)** — `runs.controller` (list/cost/card/cancel/
   retry), `human-tasks.controller` (list/count), guard the existing resolve endpoint, add the
   `runs_workspace_created` index migration. Integration tests: filter/pagination, card shape,
   cancel guard (no `awaiting_human` overwrite), retry `409`, queue list/count, resolve resume.
6. **Frontend (US1/US2/US3/US4)** — api modules + Query composables (`refetchInterval`); fill
   `HumanQueue.vue` (list + actions + history + badge), `RunCard.vue` (checklist + timeline +
   history + cancel/retry), `Runs.vue` (table + filters + cost), `WorkspaceSettings` Executors
   section + pause toggle, `AgentForm` picker from `/executors`, `ExecutorForm`. msw component
   tests for the queue, card, table, and executor form.
7. **Wire-up** — navbar badge + landing rule; routes for run card + workspace settings; docs
   (`docs/progress.md` iteration entry, `docs/local-setup.md` if any env note).

## Complexity Tracking

*No constitution violations — table intentionally empty.*

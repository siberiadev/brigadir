# Implementation Plan: Orchestrator-Based Blocked-Ticket Routing ("brigadir" agent)

**Branch**: `010-orchestrator-routing` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-orchestrator-routing/spec.md`

## Summary

When a worker run finishes terminally failed today, the ticket lands in the agent's
failure status ("Blocked") and dies there. This feature closes the loop: after the
existing failure transition/comment, the pipeline starts exactly one in-process
**triage run** for a per-workspace **orchestrator agent ("brigadir")**. The orchestrator
sees the failing run's report, the worker-agent roster, and the ticket's rework-cycle
count (all injected via an automatic **handoff section** — no worker instruction changes),
and returns a new **"routed"** report outcome that either sends the ticket back to a
worker agent with a written rework task or escalates to a human. A deterministic,
pipeline-enforced **rework-cycle budget** (default 2) caps the loop with a human fallback.
The Human Queue resume flow gains an **agent picker**, and a new platform **General settings**
section holds a centrally editable **default orchestrator instruction**.

Technical approach: extend the existing report/trigger contracts, the `PipelineService`
completion path, `RunTriggerService`, the two run processors' prompt assembly, and the
`ResumeService`; add a `global_settings` table and orchestrator seeding/backfill; surface
the changes in the Vue dashboard. All new pipeline logic ships with unit + integration
tests against real Postgres/Redis under the mock executor (Constitution VI), including a
new `routed` mock scenario to exercise the full fail → triage → route → rework → success loop.

## Technical Context

**Language/Version**: TypeScript 5.7 (strict), Node ≥ 22, pnpm 9 workspace monorepo

**Primary Dependencies**: NestJS 11 (backend + worker WorkerHost), BullMQ 5, drizzle-orm
(Postgres), zod (contracts), Vue.js 3 + TanStack Query + Element Plus (dashboard)

**Storage**: Postgres 16 (system of record — runs, agents, workspaces, human_tasks, run_events,
and a new `global_settings` table); Redis (BullMQ queues only, nothing durable)

**Testing**: vitest — `--project unit` (mocked/in-memory) and `--project integration`
(testcontainers Postgres + Redis, shared per run via `test/integration/global-setup.ts`);
per-suite BullMQ `prefix` isolation; mock executor as the sanctioned pipeline harness

**Target Platform**: Linux server (docker compose: postgres, redis, backend, worker) +
browser dashboard

**Project Type**: Web application — NestJS backend/worker (`apps/`, `libs/`), shared typed
contracts (`packages/contracts`), Vue SPA (`apps/web`)

**Performance Goals**: Not latency-bound. Triage must be enqueued in-process on completion
processing (no polling delay — FR-004); handoff assembly must be size-bounded and best-effort
(FR-013). Orchestrator runs on the cheapest suitable executor profile with a short turn limit.

**Constraints**: No new Jira board statuses (orchestrator's success/failure mappings are inert
placeholders — FR-007); routing never passes through a trigger status (poller-safe — FR-008);
all report fields including the routing task pass the secret scrubber (FR-003); handoff reads
only from the system's own run history (FR-013). Existing behavior preserved: worker failure
still transitions + comments before triage begins (Assumptions).

**Scale/Scope**: Internal team tool, single-digit workspaces. Scope spans contracts, DB
migration, pipeline completion path, run-trigger, both run processors' prompt assembly, resume
flow, seeding/backfill, and ~5 dashboard surfaces. Rework-cycle budget default 2, per workspace.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Assessment | Compliance |
|-----------|-----------|------------|
| **I. Dual Source of Truth** | Triage/rework runs live in Postgres run history; the rework-cycle count is *derived* from run history (FR-006), not a new counter of record. Handoff reads only the system's own run history (FR-013). Ticket status stays Jira-authoritative; routing transitions go through the JiraClient. No third source of truth. | ✅ PASS |
| **II. Idempotency at Three Levels** | The triage run is enqueued through `RunTriggerService`, inheriting webhook dedup + BullMQ `deduplication` + `runs_one_active`. The triage decision is recorded in the `jira_action`/completion marker so replay (drift repair) is a no-op (FR-004, SC-001). Rework enqueue reuses the same seam; routing onto an already-active agent deduplicates (Edge Cases). | ✅ PASS |
| **III. System-Only Jira Writes** | Routing comment + running-status transition are performed by the pipeline via `JiraClientFactory` through the per-issue write queue (FR-008, FR-024). Agents only *report* the `routed` outcome via `complete_task`; they never write Jira. | ✅ PASS |
| **IV. Run Completion Contract** | `routed` is a new `ReportSchema` outcome; `routed` without its payload is rejected, mirroring the `needs_human`⇒`human_task` rule (FR-001). Completion stays idempotent; no new rescue path. | ✅ PASS |
| **V. Secret Isolation & Output Scrubbing** | The routing task text passes the same secret scrubber as every other report field before persistence/Jira (FR-003). Orchestrator runs on a cheap executor profile with **no repository workspace** (FR-018) — no git creds in reach. | ✅ PASS |
| **VI. Test-Mandatory Pipeline Logic** | Every new path (triage trigger, decision processing, budget guard, override, resume picker, handoff assembly) is pipeline logic and ships with tests in the same change. The mock executor gains a `routed` scenario (FR-024) and integration tests drive the full loop (SC-003, SC-007). Idempotency has explicit replay tests (FR-004). | ✅ PASS |
| **Tech constraints** | New `global_settings` store is a versioned, checked-in Postgres migration (system of record). All resource resolution stays inside DI factories (lazy). Contracts extended in `packages/contracts`. Vue consumes REST. No new executor/runtime forks — orchestrator is an ordinary agent on a distinct executor profile. | ✅ PASS |

**Result**: PASS — no violations. Complexity Tracking table left empty.

## Project Structure

### Documentation (this feature)

```text
specs/010-orchestrator-routing/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output — decisions D1..D12
├── data-model.md        # Phase 1 output — entities, schema deltas, migration
├── quickstart.md        # Phase 1 output — end-to-end validation scenarios
├── contracts/           # Phase 1 output — report, trigger, routing, resolve, settings
│   ├── report-schema.md
│   ├── trigger-event.md
│   ├── handoff-section.md
│   ├── resolve-human-task.md
│   └── global-settings-api.md
├── checklists/          # pre-existing
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

This is an existing NestJS + Vue monorepo; the feature edits established modules rather than
adding a new top-level tree. Touched paths (→ = extend, + = new):

```text
packages/contracts/src/
├── report.schema.ts             → add "routed" outcome + routing payload; superRefine rule
├── trigger-event.schema.ts      → fix "human_resume"→"human-resume"; add triage/rework sources
│                                    + handoff fields (failing_run_id, deciding_run_id, task, human_task_id)
├── global-settings.schema.ts    + General-settings API contract (default orchestrator instruction)
└── index.ts                     → re-exports

libs/database/src/schema/
├── global-settings.ts           + new key-value table (system of record; FR-021)
├── agents.ts                    → add `description` (FR-020) + orchestrator marker (behavior flag or column)
├── workspaces.ts                → settings.rework_max used (FR-006); no column change required
└── index.ts                     → re-export

drizzle/
├── 0004_orchestrator_routing.sql + global_settings table, agents.description, orchestrator marker
└── REVIEW-0004_orchestrator_routing.md + SQL review vs architecture.md §3

libs/pipeline/src/pipeline.service.ts   → after failure transition/comment: triage trigger,
                                          budget guard, orchestrator-decision processing,
                                          override-to-human, orchestrator-run failure handling (FR-004..011)
libs/pipeline/src/handoff.ts            + handoff-section assembly (triage/rework/human-resume; FR-012..014)
libs/pipeline/src/rework-budget.ts      + derive rework-cycle count from run history (FR-006)

libs/runs/src/run-trigger.service.ts    → carry triage/rework trigger events (references to failing/deciding runs)
libs/human-tasks/src/resume.service.ts  → optional target agent, attempt renumber, handoff trigger (FR-015/016)
libs/human-tasks/src/human-task.service.ts → non-blocking human tasks from triage overrides (FR-005/009/010)

libs/executors/src/mock.executor.ts     → "routed" scenario (FR-024)
libs/jira/src/adf-composer.ts           → "routed" outcome panel + target/task line (FR-024)

apps/worker/src/run.processor.ts             → inject handoff section into instruction (FR-012)
apps/worker/src/claude-cli-run.processor.ts  → replace instructionWithResumeAnswer with handoff (FR-014)

apps/backend/src/dashboard/
├── workspaces.controller.ts     → seed orchestrator agent on wizard create (FR-018)
├── agents.controller.ts         → reject orchestrator delete (409); expose description (FR-019/020)
├── general-settings.controller.ts + General settings GET/PUT (FR-021)
└── orchestrator-backfill.service.ts + startup insert-if-absent backfill (FR-018)

libs/app-config/src/config-seeder.ts    → seed orchestrator on yaml workspace seed (FR-018)

apps/web/src/
├── views/…SettingsView                → "General" tab: default orchestrator instruction (FR-021)
├── views/…HumanQueue                   → agent picker on blocking resume (FR-017)
├── components/…AgentForm               → description field; hide delete for orchestrator (FR-019/020)
└── api/…                               → new endpoints

Tests (co-located *.spec.ts + test/integration/):
- report.schema.spec / trigger-event.schema.spec  (contract)
- pipeline.service triage/route/override/budget    (unit + integration)
- handoff assembly                                  (unit)
- resume picker                                     (unit + integration)
- orchestrator seeding + backfill + delete-guard    (integration)
- global-settings API                               (integration)
- full fail→triage→route→rework→success loop        (integration, mock executor; SC-007)
```

**Structure Decision**: Web-application monorepo, extended in place. The orchestrator is
modeled as an ordinary `agents` row (distinguished by a marker + a dedicated executor profile
without a workspace dir), so it flows through the existing run lifecycle, dedup, and executor
abstraction unchanged — honoring the "keep the abstractions intact" scope rule rather than
forking a parallel triage pipeline.

## Complexity Tracking

> No constitution violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

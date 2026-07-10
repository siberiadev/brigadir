# Implementation Plan: Pipeline Skeleton — Monorepo, Database, Queues, Mock Executor

**Branch**: `001-pipeline-skeleton` | **Date**: 2026-07-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-pipeline-skeleton/spec.md`

## Summary

Build BRIGADIR's orchestration foundation: a pnpm/NestJS monorepo (backend +
worker entrypoints, shared `libs/`, zod-only `packages/contracts`), the full
Postgres 16 schema from `docs/architecture.md` §3 via Drizzle with committed
SQL migrations, BullMQ 5 queues (one per executor type + reconcile scheduler
stub) with the §0.5 worker settings, a deterministic six-scenario
MockExecutor behind the `AgentExecutor` contract, fail-fast zod-validated
`agents.yaml` loading, docker-compose for the four-service stack, and
integration tests (vitest + testcontainers, real Postgres/Redis) that arrive
with each capability. No Jira, no LLMs, no callbacks, no UI (iteration 1
boundaries).

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js 22 LTS

**Primary Dependencies**: NestJS 11 (monorepo mode: apps + libs), @nestjs/bullmq + BullMQ 5, Drizzle ORM + drizzle-kit (SQL migrations, committed), zod, yaml

**Storage**: PostgreSQL 16 (system of record — all 9 tables from architecture §3 as-is); Redis 7 (BullMQ queues only, nothing durable)

**Testing**: vitest; integration via @testcontainers/postgresql + @testcontainers/redis — no mocking of BullMQ or the DB (real broker semantics are the point)

**Target Platform**: Linux server / macOS dev; docker-compose (postgres, redis, backend, worker)

**Project Type**: Web service backend (control plane) + queue worker (execution plane), single Nest project, two entrypoints (`main.api.ts` / `main.worker.ts`)

**Performance Goals**: n/a this iteration (skeleton correctness over throughput); queue concurrency honors per-executor `concurrency_limit`

**Constraints**: `maxStalledCount: 0`, `maxRetriesPerRequest: null`, `removeOnComplete {count:1000}` / `removeOnFail {count:5000}`; graceful shutdown ≤ 30 s; schema implemented as-is (no redesign); mock scenario carried in `runs.trigger_event` JSONB (no schema changes)

**Scale/Scope**: single workspace, single-digit agents, tens of concurrent runs — internal team tool

All decisions above were fixed by the invoking instruction; none are open. **No NEEDS CLARIFICATION remain** — mechanics resolved in [research.md](research.md) (D1–D8).

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.0.0 — pre-research and re-checked post-design. Result: **PASS**, no violations to justify.*

| Principle | Gate | Status |
|---|---|---|
| I. Dual Source of Truth | All run state in Postgres; Redis holds only queues + no durable state; `tickets.last_seen_status` treated as cache (fixtures only this iteration) | ✅ |
| II. Idempotency at Three Levels | Level 2 (BullMQ `deduplication {id: ticket:agent}`) and Level 3 (`runs_one_active` partial unique index) implemented AND explicitly tested (duplicate + concurrent race). Level 1 (webhook dedup) — table created, no webhook path exists until iteration 2; not removable, merely not yet reachable | ✅ (L1 deferred with the feature that needs it) |
| III. System-Only Jira Writes | Zero Jira writes this iteration; the `onRunFinished` seam is where iteration 2's transition logic plugs in | ✅ (vacuously; seam prepared) |
| IV. Run Completion Contract | Mock reports validated against `ReportSchema` v1 at the same gate future callbacks use; `needs_human` ⇒ required `human_task` enforced; crash-without-report ⇒ `failed` with diagnostics; terminal finalization idempotent (guarded UPDATE) | ✅ |
| V. Secret Isolation & Scrubbing | No secrets exist yet (placeholder credential bytes); no argv/env exposure introduced; encryption + scrubber land with iterations 2/5 as specced | ✅ (nothing to isolate yet) |
| VI. Test-Mandatory Pipeline Logic | Every FR on the trigger→terminal-status path ships with integration tests in the same phase (see Phasing); idempotency layers each have explicit tests; contract tests for ReportSchema/AgentsConfig; MockExecutor is the sanctioned no-LLM harness | ✅ |
| Technology Constraints | TS strict / NestJS 11 / BullMQ 5 / Postgres 16 / contracts in `packages/contracts` / executors behind `AgentExecutor` | ✅ |

**Post-design re-check**: design artifacts introduce three deliberate,
documented deviations from *architecture docs* (not the constitution) —
research.md F1 (`mock` executor type added to the type union), F2
(`needs_human` without the Jira half), F3 (reconcile as no-op stub). All
three are additive/stubbed seams, flagged per the plan constraints, and do
not touch constitutional gates.

## Project Structure

### Documentation (this feature)

```text
specs/001-pipeline-skeleton/
├── plan.md              # This file
├── spec.md
├── research.md          # D1–D8 decisions, F1–F3 deviation flags
├── data-model.md        # §3 mapping notes + run state machine
├── quickstart.md        # validation guide
├── contracts/
│   └── contracts.md     # C1–C7: executor, schemas, queue, trigger, ops
└── checklists/requirements.md
```

### Source Code (repository root)

```text
apps/
├── backend/                 # Nest app; entry src/main.api.ts
│   └── src/
│       ├── main.api.ts      # HTTP bootstrap: migrations → seed from yaml → /health
│       └── health/          # GET /health (db + redis probes)
└── worker/                  # Nest app; entry src/main.worker.ts
    └── src/
        ├── main.worker.ts   # queue consumers bootstrap; enableShutdownHooks
        ├── run.processor.ts # RunProcessor extends WorkerHost (per-queue instances)
        └── reconcile.processor.ts  # no-op sweeper

libs/                        # shared Nest modules (Nest monorepo convention)
├── database/                # DrizzleModule: client provider, schema/*.ts (9 tables), migrator
├── app-config/              # agents.yaml loader (AGENTS_CONFIG_PATH), fail-fast provider, seeder
├── queues/                  # queue registry (run.<type> + reconcile), enqueue options, backoff stub
├── runs/                    # RunsService (state machine, guarded finalize), RunTriggerService (C6)
└── executors/               # AgentExecutor interface, registry, MockExecutor

packages/
└── contracts/               # plain TS + zod ONLY: ReportSchema v1, CallbackTools,
                             # AgentsConfigSchema, trigger_event schema, shared types

test/
├── integration/             # vitest + testcontainers suites (scenarios, dedup, rate-limit,
│                            # config matrix, finalize/scheduler idempotency)
└── fixtures/                # agents.yaml variants (valid + broken matrix), ticket fixtures

drizzle/                     # committed SQL migrations (drizzle-kit output, reviewed vs §3)
docker-compose.yml           # postgres, redis, backend, worker
agents.yaml                  # example config (mock executor)
docs/progress.md             # iteration journal (created this iteration)
```

**Structure Decision**: NestJS monorepo mode inside a pnpm workspace
(research D2): `apps/backend` and `apps/worker` are two build targets of one
Nest project; shared modules live in `libs/*`; `packages/contracts` stays
framework-free so the future `packages/mcp-server` and web app can consume
it. One Docker image, two start commands.

## Implementation Phasing (input for /speckit-tasks)

Ordered so that **integration tests land in the same phase as the capability
they prove** (Constitution VI) — not as a final batch:

1. **Workspace scaffold**: pnpm + Nest monorepo, `packages/contracts` with all
   zod schemas + **contract unit tests** (ReportSchema incl. needs_human
   conditional; AgentsConfigSchema matrix). Typecheck/lint green.
2. **Database layer**: Drizzle schema ×9, generated SQL reviewed against §3,
   migrator; **test**: migrations apply from scratch on a testcontainer;
   `runs_one_active` proven by direct concurrent INSERTs.
3. **Config loading + seed**: fail-fast provider, yaml→DB seeder; **test**:
   startup matrix (valid/broken×4) asserting exit behavior and error paths.
4. **Queues + trigger**: queue registry, `RunTriggerService`, dedup options,
   backoff stub, reconcile scheduler; **test**: duplicate + concurrent
   enqueue ⇒ one active run; scheduler upsert idempotency.
5. **Executor + processor**: `AgentExecutor`, MockExecutor (six scenarios),
   RunProcessor with the D4 mapping, human-task creation, guarded finalize,
   graceful shutdown; **test**: six scenario suites + rate-limit attempt
   accounting + finalize idempotency (US1 acceptance ×6).
6. **Ops & docs**: docker-compose (healthchecks, stop_grace_period), README
   (≤ 15 min), `docs/progress.md` entry, quickstart walkthrough executed
   end-to-end as the DoD gate.

## Complexity Tracking

> No constitutional violations — table records the flagged doc deviations for traceability (details in research.md).

| Deviation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| F1: `mock` added to executor type union (§4 lists only 4 real types) | NFR item 5 mandates a mock executor; it must flow through the real registry/queue path to be worth testing | A test-only fake outside the registry wouldn't exercise queue topology, config, or the D4 mapping — the very things this iteration exists to prove |
| F2: `needs_human` performs only the Postgres half (no Jira Blocked transition per §2) | Jira is iteration-2 scope; spec forbids Jira HTTP here | Stubbing a fake JiraModule now would create throwaway code and blur Constitution III's single-write-path rule |
| F3: reconcile sweeper is a scheduled no-op (§4 gives it 3 duties) | Scheduler registration/idempotency is this iteration's deliverable; duties need Jira + real executors | Omitting the queue entirely would leave scheduler-upsert semantics untested until iteration 2 |

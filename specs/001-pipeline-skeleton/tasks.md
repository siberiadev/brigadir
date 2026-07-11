---
description: "Task list for Pipeline Skeleton — Monorepo, Database, Queues, Mock Executor"
---

# Tasks: Pipeline Skeleton — Monorepo, Database, Queues, Mock Executor

**Input**: Design documents from `/specs/001-pipeline-skeleton/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/contracts.md, quickstart.md

**Organization**: Phases follow the plan's **Implementation Phasing** (1–6) exactly. Integration tests live in the same phase as the capability they prove (Constitution VI — no end-of-project test batch). Story labels map to spec.md user stories: **US1** run lifecycle (P1), **US2** no duplicate active runs (P2), **US3** fail-fast config (P3), **US4** one-command environment (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task in the same/earlier phase
- **[Story]**: US1–US4 where the task serves a specific user story; setup/foundational/ops tasks carry no story label
- Every task names its **Verify:** step (command or concrete check)

## Path Conventions

Monorepo root = repository root. `apps/backend`, `apps/worker`, `libs/*`, `packages/contracts`, `test/`, `drizzle/` per plan.md "Source Code" tree.

---

## Phase 1: Workspace Scaffold + Contracts (Setup)

**Goal**: pnpm/NestJS monorepo skeleton compiles; `packages/contracts` holds every zod schema with contract tests green. **Proves**: nothing runtime yet; establishes the typed contract layer US3 and later phases depend on.

- [X] T001 Initialize pnpm workspace at repo root: `package.json` (private, `packageManager: pnpm`), `pnpm-workspace.yaml` (globs `apps/*`, `libs/*`, `packages/*`), root `tsconfig.base.json` (strict, `target ES2023`, `module NodeNext`), `.gitignore`, `.nvmrc` (Node 22). **Verify**: `pnpm install` exits 0; `node -v` matches `.nvmrc`.
- [X] T002 [P] Scaffold NestJS monorepo shell: `nest-cli.json` with `apps/backend` + `apps/worker` projects and `libs/{database,app-config,queues,runs,executors}` libraries; empty `main.api.ts` / `main.worker.ts` that bootstrap an empty `AppModule` and log a start line. **Verify**: `pnpm nest build backend && pnpm nest build worker` both exit 0.
- [X] T003 [P] Create `packages/contracts` package (plain TS, zod only — **no** `@nestjs/*` deps): `package.json` name `@brigadir/contracts`, own `tsconfig.json`, `src/index.ts` barrel, vitest config. **Verify**: `pnpm --filter @brigadir/contracts build` exits 0; `pnpm why @nestjs/core --filter @brigadir/contracts` prints nothing (framework-free per Constitution / research D2).
- [X] T004 [P] [US1] Implement `ReportSchema` v1 in `packages/contracts/src/report.schema.ts` per contracts.md C2 / architecture §6: `schema_version` literal 1, `outcome` enum, `summary`≤2000, `checks`≤50 (name≤200, status enum, reason≤1000), optional `human_task`, optional `artifacts`, `.strict()`, and `.superRefine` making `human_task` required when `outcome==='needs_human'`. **Verify**: unit test `report.schema.spec.ts` — valid success/failure/needs_human docs pass; needs_human-without-human_task and extra-property docs fail.
- [X] T005 [P] Implement `CallbackTools` schemas (`report_progress`, `request_human`, `complete_task`) in `packages/contracts/src/callback-tools.schema.ts` per contracts.md C3 / architecture §5 (shapes only; unused until iteration 5). **Verify**: unit test asserts each schema parses a representative payload and rejects one malformed payload.
- [X] T006 [P] [US3] Implement `AgentsConfigSchema` in `packages/contracts/src/agents-config.schema.ts` per contracts.md C4 / spec §0.1: workspace object, `executors` record (type union **includes `mock`** — research F1), agents array with defaults (`timeout_minutes` 45, `max_attempts` 2) and `.superRefine` cross-refs (every `agents[].executor` names an existing key; agent names unique). Error messages carry zod issue paths. **Verify**: unit test `agents-config.schema.spec.ts` — valid config passes; missing-field, wrong-type, and dangling-executor-ref configs each fail with the offending path in the issue.
- [X] T007 [P] [US1] Implement `TriggerEventSchema` in `packages/contracts/src/trigger-event.schema.ts` per data-model.md: `{source:'manual', mock_scenario?: enum(6), rate_limit_ttl_ms?}`, absent `mock_scenario` ⇒ defaults `success`. Export all schemas + inferred types from `src/index.ts`. **Verify**: unit test confirms default applied; `pnpm --filter @brigadir/contracts test` all green.

**Checkpoint P1**: `pnpm typecheck` + `pnpm --filter @brigadir/contracts test` green; contracts package has zero Nest deps.

---

## Phase 2: Database Layer (Foundational — blocks Phases 3–5)

**Goal**: all 9 tables from architecture §3 exist via committed SQL migrations that apply from scratch; the `runs_one_active` guard is proven at the DB level. **Proves**: US1/US2 storage substrate. **⚠️ Blocks all later phases.**

- [X] T008 Add Drizzle deps and `libs/database` module: `drizzle-orm`, `drizzle-kit`, `pg`; `drizzle.config.ts` (schema dir `libs/database/src/schema`, out `drizzle/`, dialect `postgresql`); `DatabaseModule` exporting a `DRIZZLE` client provider from `DATABASE_URL`. **Verify**: `pnpm nest build backend` exits 0; module imports without a live DB.
- [X] T009 [P] Define Drizzle schema for config tables in `libs/database/src/schema/`: `workspaces.ts`, `executors.ts`, `agents.ts` — columns/defaults/uniques **as-is** per architecture §3 (`jira_credentials bytea NOT NULL`, `settings jsonb default '{}'`, `UNIQUE(workspace_id,name)` on executors+agents, FK cascade from workspace, `executor_id` FK no-cascade). **Verify**: `pnpm drizzle-kit generate` produces SQL with no diff-worthy deviation from §3 columns (checked in T014).
- [X] T010 [P] Define Drizzle schema for run/ticket tables in `libs/database/src/schema/`: `tickets.ts`, `runs.ts`, `run_checks.ts`, `run_events.ts` — including `runs` full status set, `attempt default 1`, `trigger_event jsonb`; `run_events` PK `bigint GENERATED ALWAYS AS IDENTITY`; the `runs_one_active` partial unique index and `runs_ticket` index; cascade on run_checks/run_events. **Verify**: generated SQL contains the exact `CREATE UNIQUE INDEX runs_one_active ... WHERE status IN ('queued','running','awaiting_human')` (checked in T014).
- [X] T011 [P] Define Drizzle schema for `human_tasks.ts` and `webhook_events.ts` in `libs/database/src/schema/` per §3: `human_tasks` with `blocking default true`, partial index `human_tasks_open ... WHERE status='open'`; `webhook_events` `UNIQUE(workspace_id, external_id)`. Barrel-export all schema from `libs/database/src/schema/index.ts`. **Verify**: `pnpm nest build` exits 0; schema barrel type-checks.
- [X] T012 Generate the initial migration and add a migrator: run `pnpm drizzle-kit generate` → commit SQL under `drizzle/`; implement `runMigrations()` (drizzle `migrate`) invoked from backend bootstrap before `/health` reports ok. **Verify**: run migrator against a throwaway local Postgres 16 → all tables present (`\dt` shows 9 tables).
- [X] T013 [P] Stand up the integration test harness in `test/integration/`: vitest config, `@testcontainers/postgresql` + `@testcontainers/redis` fixtures, a helper that boots a container, runs the committed migrations, and returns a Drizzle client + fixture seeders (workspace/executor/agent/ticket). **Verify**: `pnpm test:integration test/integration/harness.spec.ts` — boots Postgres, applies migrations from scratch, asserts 9 tables exist, tears down.
- [X] T014 **[Verification duty — research D1]** Line-by-line review the committed `drizzle/*.sql` against architecture §3; record the diff result in a comment block at the top of the migration or in `docs/progress.md`. Confirm specifically: `runs_one_active` partial unique index predicate; `human_tasks_open` partial index predicate; `run_events` `bigint GENERATED ALWAYS AS IDENTITY` PK; every `ON DELETE CASCADE` (workspace→children, run→run_checks/run_events). Fix schema + regenerate if any drift. **Verify**: written confirmation that generated DDL matches §3 for all four flagged items; `runs_one_active` proven by integration test `db-constraints.spec.ts` — two concurrent INSERTs of an active run for the same (ticket,agent) ⇒ exactly one succeeds, the other raises unique violation.

**Checkpoint P2**: migrations apply from scratch on a fresh container; `runs_one_active` enforced; DDL reviewed against §3.

---

## Phase 3: Config Loading + Seed (US3)

**Goal**: startup loads & validates `agents.yaml`, fails fast on bad config, and seeds workspace/executors/agents into Postgres. **Independent test**: start against valid and broken configs; assert boot vs non-zero exit with a path-qualified error.

- [X] T015 [US3] Implement the fail-fast config provider in `libs/app-config/src/agents-config.provider.ts`: read `AGENTS_CONFIG_PATH` (default `./agents.yaml`), parse YAML (`yaml` pkg), validate with `AgentsConfigSchema`; on `ZodError`/parse error/missing file, throw a fatal error naming the file path + dot-joined issue path **before** Nest finishes bootstrapping (non-zero exit, no partial boot). **Verify**: unit test drives the provider with fixture paths; integration-lite test runs `main.api.ts` bootstrap against a broken fixture and asserts non-zero exit + stderr contains file + field path.
- [X] T016 [P] [US3] Author `agents.yaml` example (mock executor) at repo root and the broken-config matrix in `test/fixtures/`: `broken-missing-field.yaml`, `broken-wrong-type.yaml`, `broken-dangling-executor.yaml`, `broken-unparseable.yaml`, plus a valid `agents.valid.yaml`. **Verify**: each fixture loads (valid) or fails (broken) as expected in T017's suite.
- [X] T017 [US3] Implement the yaml→DB seeder in `libs/app-config/src/config-seeder.ts`: upsert workspace (placeholder `jira_credentials` bytes — research D6/spec assumption), executors, and agents from validated config on backend boot; idempotent (re-run leaves one row set). **Verify**: integration test `config-seed.spec.ts` — boot with `agents.valid.yaml` ⇒ workspace/executors/agents rows present; boot twice ⇒ no duplicate rows; the four broken fixtures each abort startup with a path-qualified error (US3 acceptance matrix).

**Checkpoint P3**: valid config boots+seeds idempotently; every broken config aborts with a clear, located error.

---

## Phase 4: Queues + Trigger (US2)

**Goal**: one queue per executor type + reconcile scheduler; enqueue path enforces dedup (BullMQ level + DB level) so duplicate triggers never create a second active run. **Independent test**: enqueue same (ticket,agent) twice (sequential + concurrent) ⇒ one active run, one job.

- [X] T018 Implement the queue registry in `libs/queues/src/queues.module.ts` using `@nestjs/bullmq`: register `run.<executorType>` queues from loaded config (this iteration: `run.mock`) + a `reconcile` queue; connection `maxRetriesPerRequest: null`; default job opts `removeOnComplete {count:1000}`, `removeOnFail {count:5000}`; register the custom backoff stub `settings.backoffStrategy = (attempt)=>min(2^attempt*1000,30000)+jitter` (research D3). **Verify**: `pnpm nest build worker` exits 0; integration test asserts the `run.mock` + `reconcile` queues register against a Redis container.
- [X] T019 Implement `RunTriggerService` in `libs/runs/src/run-trigger.service.ts` per contracts.md C6: INSERT `runs` (status `queued`, attempt 1); catch `runs_one_active` unique violation → return `{deduplicated:true, existingRunId}`; else `queue.add('run', {runId}, {deduplication:{id:\`${ticketId}:${agentId}\`}, attempts: agent.max_attempts, backoff:{type:'custom'}})`. **Verify**: unit test asserts payload shape/options; covered end-to-end in T021.
- [X] T020 [P] Implement the reconcile no-op processor in `apps/worker/src/reconcile.processor.ts` and register the scheduler via `queue.upsertJobScheduler('reconcile', {every:300_000})` at worker bootstrap (research F3 — handler logs one event, no side effects). **Verify**: integration test boots the worker context twice and asserts exactly one `reconcile` scheduler exists (`getJobSchedulers` length 1 — upsert idempotency, spec FR-010).
- [X] T021 [US2] Integration test the dedup guarantee in `test/integration/dedup.spec.ts`: (a) trigger (T,A) twice sequentially ⇒ one active run row, second call returns `deduplicated:true`; (b) fire N concurrent triggers for (T,A) ⇒ exactly one active run, one enqueued job, losers observe "already exists" without crashing; (c) finish the run, trigger again ⇒ a new run IS created (guard applies to active runs only). **Verify**: `pnpm test:integration test/integration/dedup.spec.ts` green; asserts SC-002 across N≥2 (US2 acceptance + Constitution II).

**Checkpoint P4**: duplicate/concurrent enqueue ⇒ one active run; reconcile scheduler idempotent.

---

## Phase 5: Executor + Processor (US1)

**Goal**: MockExecutor drives all six deterministic scenarios through `RunProcessor`; runs reach the correct terminal/active status per the D4 mapping; needs_human creates a human_task; crash retries the same row; rate_limited re-queues without burning an attempt. **Independent test**: one run per scenario ⇒ expected status, repeatably.

- [X] T022 Define the `AgentExecutor` interface + registry in `libs/executors/src/`: `agent-executor.interface.ts` (type union **incl. `mock`** — research F1; `run(ctx,signal)`, `healthCheck()`), `RunContext`/`ExecutorResult` per architecture §4 (`workspaceDir:null`, placeholder `callback`), and an `ExecutorRegistry` resolving by type. **Verify**: `pnpm nest build` exits 0; unit test resolves the mock executor from the registry.
- [X] T023 [P] [US1] Implement the pure `mapExitStatusToRunStatus()` function in `libs/runs/src/status-mapping.ts` per research D4 / architecture §4 (completed+outcome → succeeded/failed/awaiting_human; crashed → retry-or-failed; timeout → timed_out; rate_limited → re-queue; cancelled → cancelled). **Verify**: unit test `status-mapping.spec.ts` covers every `exitStatus`×`outcome` combination exhaustively.
- [X] T024 [P] [US1] Implement `MockExecutor` in `libs/executors/src/mock.executor.ts` per research D5: read `run.trigger_event.mock_scenario`; produce deterministic results for `success`/`failure`/`needs_human`/`timeout`/`crash`; for `rate_limited` use the persisted `run_events` marker (first pass → rate_limited, next → success). `healthCheck()`→`{ok:true}`. **Verify**: unit test drives each scenario twice and asserts identical outputs (determinism, SC-001); rate_limited flips on the second call.
- [X] T025 [US1] Implement `RunsService` state machine in `libs/runs/src/runs.service.ts` per data-model.md invariants: guarded finalize (`UPDATE ... WHERE status IN active` → 0 rows ⇒ log+skip), `started_at`/`finished_at` stamping, `attempt` increment only on crash-retry, write `run_checks` from the validated report, create an open `human_tasks` row for `awaiting_human` (dedup: skip if run already has an open task). Reports validated against `ReportSchema` before persistence (Constitution IV gate). **Verify**: unit tests for terminal-immutability and awaiting_human⇒human_task invariants; covered end-to-end in T027.
- [X] T026 [US1] Implement `RunProcessor extends WorkerHost` in `apps/worker/src/run.processor.ts` (one class, per-`run.<type>`-queue instance; `maxStalledCount:0`): load run+agent+workspace, mark `running`+`started_at`, resolve executor from registry, `executor.run(ctx, abortSignal)`, apply `mapExitStatusToRunStatus`, finalize via `RunsService`; rate_limited ⇒ `worker.rateLimit(ttl)` + `Worker.RateLimitError()` (no attempt consumed); crash ⇒ throw for BullMQ retry (same row, attempt+1) then `failed` on exhaustion. Wire `enableShutdownHooks()` + `worker.close()` graceful shutdown in `main.worker.ts`. **Verify**: `pnpm nest build worker` exits 0; behavior asserted in T027/T028.
- [X] T027 [US1] Integration test the six scenarios in `test/integration/scenarios.spec.ts`: for each of `success|failure|needs_human|timeout|crash|rate_limited`, seed fixtures, trigger via `RunTriggerService`, poll `runs` to the expected status (succeeded/failed/awaiting_human/timed_out/failed-after-retries); assert `needs_human` created exactly one open human_task; assert `crash` retried the same run row with attempt incremented then ended failed on exhaustion. **Verify**: `pnpm test:integration test/integration/scenarios.spec.ts` green; rerun ⇒ identical results (SC-001 determinism; US1 acceptance 1–5).
- [X] T028 [P] [US1] Integration test rate-limit attempt accounting + finalize idempotency in `test/integration/rate-limit.spec.ts`: `rate_limited` scenario ⇒ job re-queued, `runs.attempt` unchanged across the rate-limit event, later pass ⇒ `succeeded`; then call finalize again on the terminal run ⇒ 0 rows changed, status unchanged. **Verify**: `pnpm test:integration test/integration/rate-limit.spec.ts` green (SC-003, FR-008, US1 acceptance 6 + finalize-idempotency edge case).

**Checkpoint P5**: all six scenarios reach correct statuses deterministically; rate_limit preserves attempts; finalize idempotent. **MVP (US1) complete.**

---

## Phase 6: Ops & Docs (US4 + DoD Gate)

**Goal**: one-command stack boot with migrations from scratch; README ≤15 min; progress journal. **Independent test**: fresh clone → `docker compose up` → 4 services healthy.

- [X] T029 [P] [US4] Author `docker-compose.yml` at repo root: services `postgres` (16, healthcheck), `redis` (7, healthcheck), `backend` (runs migrations on boot → `/health`), `worker` (`stop_grace_period: 35s`); one image, two start commands; `.env.example` with `DATABASE_URL`, `REDIS_URL`, `AGENTS_CONFIG_PATH`, `PORT`. **Verify**: from empty volumes `docker compose up --build` → `docker compose ps` shows 4 services healthy/running; `curl localhost:3000/health` → `{status:'ok'}`.
- [X] T030 [P] [US4] Implement `GET /health` in `apps/backend/src/health/` per contracts.md C7 (db + redis probes → `{status,db,redis}`); ensure migrations+seed complete before health reports ok. **Verify**: integration test hits `/health` after boot ⇒ 200 with `db:'up'`, `redis:'up'`.
- [X] T031 [P] Add root scripts to `package.json`: `typecheck`, `lint`, `test` (unit), `test:integration`, `start:backend`, `start:worker`, `smoke:run`. **Verify**: `pnpm typecheck && pnpm lint && pnpm test` all green.
- [X] T032 [US4] Write `README.md`: prerequisites, install, `pnpm test:integration`, `docker compose up`, restart-isolation note (backend restart leaves worker/in-flight runs untouched — SC-007). **Verify**: a reader following README reaches a green `pnpm test:integration` in ≤15 min (SC-006); backend restart (`docker compose restart backend`) shows no worker disconnect in logs.
- [X] T033 **[DoD Gate]** Execute the `quickstart.md` walkthrough end-to-end (steps 1–5: install/typecheck, integration suite, compose boot, manual smoke, config fail-fast smoke) and create `docs/progress.md` with the iteration 1 entry: status, date, DoD checklist (all integration tests green; compose boots 4 services; migrations from scratch; README ≤15 min), and the three flagged deviations **F1** (`mock` executor type added), **F2** (`needs_human` Postgres-only, no Jira), **F3** (reconcile no-op stub). **Verify**: every quickstart step passes as documented; `docs/progress.md` committed with iteration 1 recorded and F1–F3 noted.

**Checkpoint P6**: full stack boots one-command; quickstart passes end-to-end; progress journal records DoD + deviations.

---

## Dependencies & Execution Order

### Phase order (strict, per plan Implementation Phasing)

- **Phase 1 (Setup/Contracts)** → no deps; start immediately.
- **Phase 2 (Database)** → depends on P1 (contracts types used in schema/seed). **Blocks P3, P4, P5.**
- **Phase 3 (Config+Seed)** → depends on P2 (seeder writes rows) + `AgentsConfigSchema` (T006).
- **Phase 4 (Queues+Trigger)** → depends on P2 (runs table + `runs_one_active`); independent of P3.
- **Phase 5 (Executor+Processor)** → depends on P4 (trigger/queue) + P2 (runs/human_tasks) + T004 ReportSchema.
- **Phase 6 (Ops+Docs)** → depends on P5 (needs a working pipeline to boot/demo).

### Explicit blocking edges called out by the user

- Database layer (P2) **blocks** queues (P4): `RunTriggerService` relies on the `runs_one_active` index (T010/T014) for its dedup catch.
- Queues (P4) **block** executor/processor (P5): `RunProcessor` consumes jobs enqueued by `RunTriggerService`.

### Parallelizable vs sequential

- **Parallel within P1**: T002, T003, T004, T005, T006, T007 (distinct files) after T001.
- **Parallel within P2**: T009, T010, T011 (distinct schema files) after T008; T013 alongside T012.
- **Cross-phase parallel**: `packages/contracts` (P1) and the `docker-compose.yml` skeleton (T029) can be drafted in parallel — compose has no code dependency (only wired/verified at P6).
- **Sequential**: T001→T002; T008→(T009/T010/T011)→T012→T014; T018→T019→T021; T022→(T023/T024)→T025→T026→T027.

---

## Parallel Execution Examples

```bash
# Phase 1 contract schemas (after T001–T003):
Task T004: ReportSchema v1 in packages/contracts/src/report.schema.ts
Task T005: CallbackTools in packages/contracts/src/callback-tools.schema.ts
Task T006: AgentsConfigSchema in packages/contracts/src/agents-config.schema.ts
Task T007: TriggerEventSchema in packages/contracts/src/trigger-event.schema.ts

# Phase 2 schema definitions (after T008):
Task T009: config tables (workspaces/executors/agents)
Task T010: run/ticket tables (+ runs_one_active)
Task T011: human_tasks + webhook_events
```

---

## Implementation Strategy

### MVP scope

**US1 (run lifecycle) is the MVP** — reached at the **end of Phase 5**. It requires Phases 1→2→4→5 (Phase 3 config-seed can use a hand-inserted fixture row if racing US1, but the plan runs P3 before P4 for a clean seed path). Stop-and-validate at Checkpoint P5: all six scenarios green proves the orchestration spine.

### Incremental delivery

1. Phases 1–2 → typed contracts + schema that migrates from scratch (foundation).
2. Phase 3 → config-driven boot (US3 demoable).
3. Phase 4 → dedup guarantee (US2 demoable — Constitution II).
4. Phase 5 → full run lifecycle (US1 / MVP).
5. Phase 6 → one-command ops + DoD gate (US4).

### Notes

- Tests are **mandatory** for every pipeline-logic task here (Constitution VI); they ship in the same phase, not batched — enforced by the per-phase integration `.spec.ts` tasks (T013/T014, T017, T020/T021, T027/T028, T030).
- Deviations F1–F3 are intentional and recorded at T033; do not "fix" them into iteration-2 scope.

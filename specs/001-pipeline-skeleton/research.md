# Research: Pipeline Skeleton (001)

**Date**: 2026-07-10 | **Spec**: [spec.md](spec.md)

All top-level technology choices were fixed by the user invocation and the
constitution; no `NEEDS CLARIFICATION` markers existed in the spec. This
document records those decisions with rationale, resolves the few genuinely
open mechanics, and flags every deliberate deviation from the normative docs.

## D1. ORM & migrations: Drizzle ORM + drizzle-kit

- **Decision**: Drizzle ORM for data access; drizzle-kit generates plain SQL
  migration files which are committed and applied by a migration runner at
  startup (backend) / in CI tests. Schema definitions in TypeScript mirror
  `docs/architecture.md` §3 exactly.
- **Rationale**: docs/spec.md §0.1 allowed "Drizzle or TypeORM — choose at
  start, then never change"; the choice is now made (user decision).
  Drizzle's SQL-first migrations satisfy the "schema as-is" rule: generated
  SQL is reviewed against §3 line-by-line, and anything drizzle-kit cannot
  express in the TS schema DSL (if encountered) is added as a hand-written
  statement in the same migration file. Partial unique index is supported:
  `uniqueIndex('runs_one_active').on(t.ticketId, t.agentId).where(sql\`status IN ('queued','running','awaiting_human')\`)`.
- **Alternatives considered**: TypeORM (rejected: decision fixed; heavier
  runtime, migration generation less predictable for exotic DDL).
- **Verification duty**: the committed SQL for `runs_one_active`,
  `human_tasks_open` (partial index), `run_events` identity column
  (`bigint GENERATED ALWAYS AS IDENTITY`), and all `ON DELETE CASCADE`
  clauses must be diffed against §3 during implementation review.

## D2. Monorepo layout: pnpm workspaces + NestJS monorepo mode

- **Decision**: repository root is both the pnpm workspace root and a NestJS
  CLI monorepo root.
  - `apps/backend` — Nest app, entry `src/main.api.ts` (HTTP: health only
    this iteration; runs migrations on boot).
  - `apps/worker` — Nest app, entry `src/main.worker.ts` (BullMQ consumers;
    no HTTP).
  - `libs/*` — shared Nest modules imported by both apps (Nest monorepo
    convention for shared code): `libs/database`, `libs/app-config`,
    `libs/queues`, `libs/runs`, `libs/executors`.
  - `packages/contracts` — plain TypeScript package (zod only, **no Nest
    dependencies**), consumed by both apps and later by `packages/mcp-server`.
- **Rationale**: docs/spec.md §0.1 says "apps/backend, apps/worker — the
  same NestJS project, separate entrypoint". Interpreted literally as two
  package.json-independent apps, sharing modules would require publishing
  the backend as a library — awkward. Nest monorepo mode gives exactly the
  intended shape: one project, two build targets (`nest build backend`,
  `nest build worker`), shared modules in `libs/`, one Docker image with two
  start commands. This honors both the directory names from the docs and
  the "one project sharing modules" intent.
- **Alternatives considered**: (a) single app with two mains in one src tree
  — loses the explicit `apps/backend` / `apps/worker` structure the docs
  name; (b) worker as thin package depending on `@brigadir/backend` — build
  ordering pain, circular-dep risk. Both rejected.
- **Flag (minor deviation)**: docs/spec.md §0.1 does not mention `libs/`;
  it is additive and is the standard NestJS monorepo location for shared
  modules. No documented structure is violated.

## D3. Queue topology & BullMQ v5 mechanics

- **Decision**: one BullMQ queue per executor **type** present in config
  (this iteration: `mock`), plus the `reconcile` queue. Registered via
  `@nestjs/bullmq`. Per-queue concurrency: `queue.setGlobalConcurrency(executor.concurrency_limit)`
  applied at worker bootstrap from the loaded config/executor rows.
- **Job payload**: `{ runId }` only (processor loads run+agent+workspace from
  Postgres — docs/spec.md §0.5 step 1). Mock scenario is NOT in the job
  payload; it rides in `runs.trigger_event` JSONB (user decision), keeping
  the job contract identical to future real executors.
- **Deduplication**: `queue.add('run', {runId}, { deduplication: { id: \`${ticketId}:${agentId}\` }, attempts: agent.max_attempts, backoff: { type: 'custom' } })`.
  BullMQ v5 semantics verified: a `deduplication.id` **without ttl** holds
  until the deduplicated job completes or fails ("standard mode") — exactly
  the window we need; it complements (not replaces) the DB partial index,
  because dedup state dies with Redis while the index does not.
- **Rate limiting without attempt burn**: processor calls
  `worker.rateLimit(ttlMs)` then throws `Worker.RateLimitError()`. Verified
  v5 behavior: the job returns to the *waiting* state and `attemptsMade` is
  NOT incremented — satisfying FR-008/SC-003. TTL for the mock: taken from
  the scenario data (default 200 ms in tests).
- **Custom backoff stub**: worker option
  `settings: { backoffStrategy: (attemptsMade, type, err, job) => number }` —
  iteration 1 ships a stub returning fixed exponential delay
  (`min(2^attempt * 1000, 30_000)` + jitter); the real classification table
  (docs/spec.md §0.5 item 6) lands with the claude_cli executor.
- **Reconcile scheduler**: `queue.upsertJobScheduler('reconcile', { every: 300_000 })`
  at worker bootstrap — v5 job schedulers are upsert-idempotent by scheduler
  id, satisfying the "no duplicate schedules across restarts" edge case.
  Handler: log-only no-op.
- **Worker settings** (docs/spec.md §0.5, verbatim): `maxStalledCount: 0`
  (stalled ⇒ job moves to failed, never silently re-run — runs are
  non-idempotent), connection `maxRetriesPerRequest: null`,
  `removeOnComplete: { count: 1000 }`, `removeOnFail: { count: 5000 }`.
- **Stalled-job caveat recorded**: with `maxStalledCount: 0` a stalled job
  fails with a `job stalled more than allowable limit` error; the processor
  cannot intercept it (it happens outside the handler). The reconcile
  sweeper (iteration 2) is the designated place to reconcile such runs; for
  iteration 1 the integration test asserts only the explicit-failure
  behavior, not recovery.

## D4. Processor design: one RunProcessor class, instantiated per queue

- **Decision**: a single `RunProcessor extends WorkerHost` class,
  parameterized by queue name; one instance registered per executor-type
  queue (`@Processor()` metadata applied via a dynamic module/factory, since
  the decorator wants a static name). Non-sandboxed (in-process) processors:
  DI access to Drizzle, config, and the executor registry; heavy lifting
  happens in spawned child processes in later iterations, so event-loop
  blocking is not a concern.
- **exitStatus → runs.status mapping** (architecture §4, implemented in a
  pure, unit-testable function):
  | ExecutorResult.exitStatus | runs.status |
  |---|---|
  | `completed` + report outcome `success` | `succeeded` |
  | `completed` + report outcome `failure` | `failed` |
  | `completed` + report outcome `needs_human` | `awaiting_human` (+ open human_task, dedup per run) |
  | `crashed` | attempts left ⇒ re-queue same run (`queued`, attempt+1); else `failed` |
  | `timeout` | `timed_out` |
  | `rate_limited` | job re-queued, run stays `running`→`queued` semantics: run row remains active, attempt NOT consumed |
  | `cancelled` | `cancelled` |
- **Retry reuses the run row** (docs/spec.md §0.4): on processor error with
  attempts remaining, set `runs.status='queued'`, `attempt = attemptsMade + 1`;
  on exhaustion, `failed`. New rows only from new triggers.
- **Terminal-write idempotency**: finalization uses a guarded UPDATE
  (`WHERE status IN (active states)`); a second finalization attempt
  affects 0 rows and is logged, not applied (spec edge case).

## D5. MockExecutor determinism

- **Decision**: `MockExecutor implements AgentExecutor` (`type: 'mock'` —
  see F1 flag). Scenario read from `run.trigger_event.mock_scenario`:
  - `success` → `{exitStatus:'completed'}` + schema-valid report
    (`outcome:'success'`, 2 checks pass) delivered through the same
    finalization path real executors will use.
  - `failure` → `completed` + report `outcome:'failure'` with one failing
    check + reason.
  - `needs_human` → `completed` + report `outcome:'needs_human'` +
    `human_task {kind:'question', title}` (ReportSchema conditional rule
    exercised).
  - `timeout` → returns `{exitStatus:'timeout', diagnostics}` immediately
    (simulates the executor-level timeout result; no real waiting).
  - `crash` → throws (simulates process crash) — exercises the BullMQ
    retry path.
  - `rate_limited` → **stateful determinism**: if no `api_retry` event
    exists yet in `run_events` for this run, record one and return
    `{exitStatus:'rate_limited'}`; on the next invocation return the
    `success` behavior. State lives in Postgres (survives worker restarts,
    deterministic given the same run), not in process memory.
- **Rationale**: NFR item 5 requires deterministic scenarios; `rate_limited`
  inherently needs "first time limited, then fine", and run_events is the
  already-persisted, queryable place to hold that fact without schema
  changes.
- `healthCheck()` → `{ok: true}` always.

## D6. Config loading (agents.yaml)

- **Decision**: zod schema `AgentsConfigSchema` in `packages/contracts`
  (workspace + record of named executors + agent list, per docs/spec.md
  §0.1 example). Loader is a Nest provider in `libs/app-config` used by
  BOTH entrypoints: reads `AGENTS_CONFIG_PATH` (default `./agents.yaml`),
  parses YAML (`yaml` package), `AgentsConfigSchema.parse()` — a `ZodError`
  is re-thrown as a fatal startup error with the file path and
  dot-separated field path (zod issue paths) before Nest finishes
  bootstrapping ⇒ non-zero exit, no partial boot.
- **Cross-reference validation**: `superRefine` — every `agents[].executor`
  must name a key in `executors`; duplicate agent names rejected
  (mirrors DB unique `(workspace_id, name)`).
- **Config → DB seed**: on backend boot, workspace/executors/agents from
  yaml are upserted into their tables (yaml is the Phase 0 source of
  agents; DB rows are what the pipeline reads at runtime — keeps runtime
  reads uniform with the Phase 1 UI future).
- **Placeholder credentials**: `workspaces.jira_credentials` is `NOT NULL`
  in §3; seeded with a fixed placeholder byte string this iteration (no
  encryption machinery yet — spec assumption; real crypto arrives with
  iteration 2).

## D7. Test harness: vitest + testcontainers

- **Decision**: vitest for unit and integration tests; `@testcontainers/postgresql`
  and `@testcontainers/redis` spin real Postgres 16 / Redis 7 per test
  suite. **No mocking of BullMQ or the database** — real broker semantics
  (dedup windows, RateLimitError, stalled behavior) are exactly what the
  tests must prove. Integration tests boot the worker's Nest application
  context in-process against the containers, insert fixtures, enqueue, and
  poll the `runs` table until a terminal/expected state (bounded timeout).
- **Migrations in tests**: applied from the committed SQL files against the
  fresh container — doubling as the "migrations apply from scratch" DoD
  check on every CI run.
- **Rationale**: constitution VI demands idempotency layers be tested for
  real (duplicate enqueue, concurrent insert race); mocked queues would
  test our mocks. Testcontainers keeps `docker compose up` unnecessary for
  running tests.
- **Alternatives considered**: jest (Nest default — slower, no advantage
  here); shared dev-compose DB for tests (rejected: stateful bleed between
  runs, breaks the from-scratch migration guarantee).

## D8. Graceful shutdown

- **Decision**: both entrypoints call `app.enableShutdownHooks()`.
  `@nestjs/bullmq` closes registered workers on application shutdown;
  `worker.close()` waits for in-flight job handlers to settle before
  resolving. Backend has no queue consumers, so its shutdown is trivial.
  A bounded wait (≤ 30 s, per NFR item 1) is enforced by the process
  manager (compose `stop_grace_period: 35s`).

## Flags — deliberate deviations from normative docs (none silent)

- **F1 — executor type `mock`**: architecture §4 enumerates
  `claude_cli | anthropic_api | deepseek_api | claude_routines`; NFR item 5
  mandates a mock executor. The `AgentExecutor.type` union and the
  agents.yaml executor schema gain a `mock` member. Additive,
  forward-compatible; the four real types stay reserved. This is the
  spec-forced extension point the plan constraints asked to have flagged.
- **F2 — `needs_human` without Jira**: architecture §2 pairs
  `outcome=needs_human` with a Jira transition to Blocked + ADF comment.
  Iteration 1 performs only the Postgres half (run → `awaiting_human`,
  open `human_tasks` row); the Jira half is out of scope until iteration 2.
  The seam (`onRunFinished` in the pipeline service) is built so the Jira
  action slots in without reshaping this iteration's code.
- **F3 — `queue:reconcile` is a no-op**: architecture §4 gives the sweeper
  three duties (poll Jira, repair runs↔queue drift, webhook refresh).
  Iteration 1 registers the scheduler and an empty handler only (spec
  FR-010). Not a redesign — a stub.
- **No other deviations**: schema §3 implemented byte-for-byte; exitStatus
  mapping per §4; worker settings per §0.5 verbatim.

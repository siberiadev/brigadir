# BRIGADIR — Progress Journal

## Iteration 1 — Pipeline Skeleton (Monorepo, Database, Queues, Mock Executor)

- **Status**: ✅ Complete — MVP (US1) reached; DoD gate passed.
- **Date**: 2026-07-10
- **Spec**: `specs/001-pipeline-skeleton/`
- **Branch**: `001-pipeline-skeleton`

### What shipped

A pnpm/NestJS monorepo with two entrypoints (`apps/backend`, `apps/worker`) plus
a one-shot `apps/smoke` trigger helper, the full Postgres 16 schema (9 tables)
via Drizzle with committed SQL migrations, BullMQ 5 queues (`run.mock` +
`reconcile`), fail-fast zod-validated `agents.yaml` loading + idempotent DB seed,
a deterministic six-scenario MockExecutor behind the `AgentExecutor` contract,
the guarded run state machine, and docker-compose for the four-service stack.
Framework-free `packages/contracts` (zod only) holds every schema.

### Definition-of-Done checklist

- [x] **All integration tests green** — `pnpm test:integration`: 10 files / 24
      tests pass (six-scenario lifecycle, dedup sequential+concurrent, rate-limit
      accounting, config-validation matrix, finalize idempotency, scheduler
      idempotency, `runs_one_active` race, health). Unit: `pnpm test` 27 pass.
- [x] **Static checks green** — `pnpm typecheck` and `pnpm lint` clean.
- [x] **Migrations apply from scratch** — every integration suite boots a fresh
      Postgres 16 container and applies the committed `drizzle/` SQL from zero;
      `docker compose up` from empty volumes does the same on backend boot.
- [x] **Compose boots 4 services** — `docker compose up --build` from empty
      volumes → `postgres` healthy, `redis` healthy, `backend` healthy
      (migrations + seed of workspace "BRIG" with 1 executor / 1 agent, then
      `GET /health` → `{status:'ok',db:'up',redis:'up'}`), `worker` up
      (reconcile scheduler upserted, consuming `run.mock`).
- [x] **Manual smoke** — `smoke:run --scenario success` → `succeeded/attempt 1`;
      `--scenario crash` → `failed/attempt 2` (retried once then failed).
- [x] **Config fail-fast** — a broken `agents.yaml` aborts boot with exit 1 and
      a stderr message naming the file and the offending field path.
- [x] **Restart isolation (SC-007)** — `docker compose restart backend` leaves
      the worker Up with no disconnect/reconnect churn in its logs.
- [x] **README ≤ 15 min** — `README.md` walks install → tests → compose for a
      newcomer.

### Environment note (not a defect)

On the dev machine used for the DoD run, `curl localhost:3000/health` returned a
404 from an **unrelated pre-existing app** (ST3 OS, `st3_os/dist/src/main`)
already bound to loopback `:3000`; `localhost:5432` was likewise a different
Postgres. The compose backend itself is correct: its in-container healthcheck
returns `{status:'ok',db:'up',redis:'up'}`, and host access via the LAN IP
(`http://<host-ip>:3000/health`) returns the same. Manual smoke was therefore
run inside the container network (where `DATABASE_URL` targets the `postgres`
service). No code change required.

### Flagged deviations from the architecture docs (intentional — do NOT "fix")

- **F1 — `mock` executor type**: architecture §4 enumerates four real executor
  types (`claude_cli | anthropic_api | deepseek_api | claude_routines`); NFR
  item 5 mandates a mock. The `AgentExecutor.type` union and the `agents.yaml`
  executor schema gain a `mock` member so the mock flows through the real
  registry/queue/config path. The four real types stay reserved.
- **F2 — `needs_human` without Jira**: architecture §2 pairs
  `outcome=needs_human` with a Jira transition to Blocked + ADF comment.
  Iteration 1 performs only the Postgres half (run → `awaiting_human`, one open
  `human_tasks` row). The Jira half is iteration-2 scope; the `onRunFinished`
  seam is prepared.
- **F3 — reconcile is a no-op stub**: architecture §4 gives the sweeper three
  duties (poll Jira, repair run↔queue drift, webhook refresh). Iteration 1
  registers the scheduler (`upsertJobScheduler('reconcile', {every: 300_000})`,
  proven idempotent) and an empty log-only handler. Duties need Jira + real
  executors (iteration 2).

No other deviations: schema §3 implemented as-is (reviewed in
`drizzle/REVIEW-0000_init.md`), the exitStatus→status mapping follows §4, and the
BullMQ worker settings follow spec §0.5 verbatim.

### Post-DoD fix (2026-07-11): integration-test flake root-caused

Full-suite runs flaked ~50% (jobs "stuck at queued/running" for 60–150 s in the
last two suites) while every suite passed in isolation. Root cause: **the queue
Redis connection was resolved at module IMPORT time** — `QueuesModule.register()`
runs inside the `@Module` decorator, so `buildRedisConnection()` read `REDIS_URL`
before test `beforeAll` (or any late env) set it and silently fell back to
`localhost:6379`, a host-installed redis-server. Every suite of every run shared
that one Redis: stale jobs from dead runs accumulated (142 keys found) and
workers burned their 2 concurrency slots retrying foreign jobs whose runIds
lived in long-gone test databases — hence mid-suite stalls that "self-healed".

Fixes:
- `QueuesModule`: `BullModule.forRoot` → **`forRootAsync`** so the connection is
  built at Nest context init (env honored). Queue *names* stay composition-time
  by design (documented in the module).
- `buildRedisConnection()` now honors the **logical DB index** from the URL path
  (`redis://host:port/2`) — previously dropped.
- Test infra: one shared Postgres + one shared Redis container per run
  (`test/integration/global-setup.ts`); per-suite isolation is logical — a fresh
  `CREATE DATABASE` and a flushed Redis logical DB per suite (harness.ts).
  Worker-booting suites gate on `worker.waitUntilReady()` before polling.

Verified: 3 consecutive full runs green (24/24), host redis no longer touched
by tests. Lesson recorded: anything read inside a `@Module` decorator argument
executes at import — connections must always be resolved in factories.

### Build/runtime note

Apps are built with NestJS's webpack bundler (`nest-cli.json` `webpack: true`)
so each entrypoint emits a single runnable `dist/apps/<app>/main.*.js` with the
`@brigadir/*` path aliases inlined; `packages/contracts` stays external and
resolves via its workspace package. Vitest emits decorator metadata via
`unplugin-swc` so NestJS type-based DI resolves in tests as it does at runtime.

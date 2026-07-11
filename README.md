# BRIGADIR — Pipeline Skeleton (Iteration 1)

Orchestration foundation for BRIGADIR: a pnpm/NestJS monorepo (backend + worker),
the full Postgres 16 schema via Drizzle with committed SQL migrations, BullMQ 5
queues, and a deterministic six-scenario **MockExecutor** driving the run
lifecycle end-to-end. No Jira, no LLMs, no UI yet — this iteration proves the
orchestration spine.

## Prerequisites

- **Node.js 22 LTS** (see `.nvmrc`) and **pnpm ≥ 9**
- **Docker** with a running daemon — needed both for `docker compose up` and for
  the integration tests (Testcontainers boots real Postgres/Redis).

## 1. Install & static checks

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace, strict mode
pnpm lint
```

`packages/contracts` is framework-free (zod only): `pnpm why @nestjs/core --filter @brigadir/contracts` prints nothing.

## 2. Integration tests (primary validation — no compose needed)

```bash
pnpm test          # unit tests (contracts + libs)
pnpm test:integration
```

Testcontainers boots Postgres 16 + Redis 7, applies the committed migrations from
scratch, boots the worker, and exercises: the six run scenarios, duplicate +
concurrent trigger dedup, rate-limit attempt accounting, the config-validation
matrix, finalize idempotency, and reconcile-scheduler idempotency. Re-running
yields identical results (determinism).

## 3. Full stack (one command)

```bash
cp .env.example .env      # optional for local, informational
docker compose up --build
```

From empty volumes: Postgres and Redis become healthy → **backend** applies all
migrations and seeds workspace/executors/agents from `agents.yaml`, then serves
`GET http://localhost:3000/health` → `{ "status": "ok", "db": "up", "redis": "up" }`
→ **worker** connects and registers the `run.mock` consumer + `reconcile`
scheduler. `docker compose ps` shows four services healthy/running.

### Restart isolation (SC-007)

```bash
docker compose restart backend
```

The backend (control plane) and worker (execution plane) are separate processes
sharing only Postgres + Redis. Restarting the backend does **not** disconnect the
worker or interrupt in-flight runs — the worker's logs show no reconnect churn.

## 4. Manual smoke (optional)

With the stack (or at least Postgres + Redis + a worker) running and the config
seeded:

```bash
pnpm smoke:run --scenario success
psql "$DATABASE_URL" -c "SELECT status, attempt, outcome FROM runs ORDER BY created_at DESC LIMIT 1;"
```

Triggers a run for a `SMOKE-1` ticket via `RunTriggerService` and polls it to a
terminal status. Scenarios: `success | failure | needs_human | timeout | crash | rate_limited`.

## 5. Config fail-fast smoke

```bash
AGENTS_CONFIG_PATH=./test/fixtures/broken-agents.yaml pnpm start:backend; echo "exit=$?"
```

Aborts before any DB work with a non-zero exit and a stderr message naming the
file and the offending field path.

## Layout

```
apps/backend   HTTP control plane: migrations → seed → /health
apps/worker    BullMQ consumers: RunProcessor (run.mock) + reconcile scheduler
apps/smoke     one-shot trigger helper (smoke:run)
libs/database  Drizzle schema (9 tables) + migrator
libs/app-config fail-fast agents.yaml loader + yaml→DB seeder
libs/queues    queue registry, backoff, connection
libs/runs      RunTriggerService, RunsService (state machine), status mapping
libs/executors AgentExecutor contract, registry, MockExecutor
packages/contracts  zod schemas (framework-free): Report, AgentsConfig, TriggerEvent, callbacks
drizzle/       committed SQL migrations (reviewed against architecture §3)
```

## Iteration boundaries

Deliberate, documented deviations from the architecture docs (see
`docs/progress.md`): **F1** a `mock` executor type, **F2** `needs_human` performs
only the Postgres half (no Jira), **F3** the reconcile sweeper is a scheduled
no-op. These are intentional seams for later iterations.

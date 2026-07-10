# Quickstart & Validation: Pipeline Skeleton (001)

Proves the feature end-to-end. Details of shapes: [contracts/contracts.md](contracts/contracts.md); entity semantics: [data-model.md](data-model.md).

## Prerequisites

- Node.js 22 LTS, pnpm ≥ 9, Docker (running daemon — needed for compose AND testcontainers).

## 1. Install & static checks

```bash
pnpm install
pnpm typecheck        # tsc --noEmit across workspace, strict mode
pnpm lint
```

**Expected**: both green; `packages/contracts` builds with no NestJS in its dependency tree (`pnpm why @nestjs/core --filter @brigadir/contracts` → empty).

## 2. Integration tests (primary validation — no compose needed)

```bash
pnpm test:integration
```

Testcontainers boots Postgres 16 + Redis 7, applies the committed SQL migrations from scratch, starts the worker application context, and runs:

| Test group | Proves | Spec ref |
|---|---|---|
| six scenario tests (`success`, `failure`, `needs_human`, `timeout`, `rate_limited`, `crash`) | each run reaches its expected status per the D4 mapping; `needs_human` also creates exactly one open human_task; `crash` retries same row with attempt+1 then fails on exhaustion | US1, FR-006/007/009 |
| duplicate enqueue (sequential + concurrent race) | exactly 1 active run, 1 execution; unique-violation path returns "already exists" | US2, FR-003/005, Constitution II |
| rate_limited attempt accounting | job re-queued, `runs.attempt` unchanged, later pass succeeds | SC-003, FR-008 |
| config validation matrix (valid / missing field / wrong type / dangling executor ref / unparseable / absent file) | fail-fast startup with path-qualified error | US3, FR-013 |
| finalization idempotency | second finalize of a terminal run changes nothing | edge case |
| scheduler idempotency | double bootstrap ⇒ one `reconcile` scheduler | FR-010 |

**Expected**: all green; repeat the suite — identical results (SC-001 determinism).

## 3. Full stack boot (DoD check)

```bash
docker compose up --build
```

**Expected**: from empty volumes — postgres healthy → backend applies all migrations, seeds workspace/executors/agents from `agents.yaml`, `GET localhost:3000/health` returns `{status:'ok'}`; worker connects, registers `run.mock` consumer + `reconcile` scheduler. `docker compose ps` shows 4 services healthy/running.

Restart isolation (SC-007): `docker compose restart backend` — worker logs show no disconnect/re-processing.

## 4. Manual smoke (optional)

```bash
pnpm smoke:run --scenario success   # inserts fixture ticket, triggers a run via RunTriggerService
psql $DATABASE_URL -c "SELECT status, attempt, outcome FROM runs ORDER BY created_at DESC LIMIT 1"
```

**Expected**: `succeeded | 1 | success` within seconds; `run_events` has the timeline; `run_checks` has the mock's checks.

## 5. Config fail-fast smoke

```bash
AGENTS_CONFIG_PATH=./test/fixtures/broken-agents.yaml pnpm start:backend; echo "exit=$?"
```

**Expected**: non-zero exit; stderr names the file and the offending field path.

## 6. Documentation DoD

- `README.md`: steps 1–3 above reproducible by a newcomer in ≤ 15 min (SC-006).
- `docs/progress.md`: iteration 1 entry recorded (status, date, DoD checklist).

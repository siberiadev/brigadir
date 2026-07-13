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

## Iteration 6 — Runs Visibility & Human Queue (feature 006)

The operational half of the dashboard. Closes product pains #2 (unreadable
reports) and #3 (no needs-human queue), and pays down iteration-5 debt
(executors admin, multi-workspace reconcile).

### What shipped

**Backend/worker (Session 1)** — executors CRUD under
`/api/workspaces/:id/executors` (typed per-type config union, default seeding on
workspace create, `OnApplicationBootstrap` type-scoped backfill, delete-guard →
409 `executor_in_use`); live concurrency re-apply on a ~15 s worker timer;
multi-workspace reconcile (every `settings.enabled != false` workspace, per-
workspace Jira client resolved lazily in `forWorkspace`, per-workspace try/catch
outage isolation); runs read surface (`/api/workspaces/:id/runs` list + cost,
`/api/runs/:id` card, guarded `cancel` `WHERE status='running'`, `retry` via
manual-trigger through all three idempotency layers); global human-queue
list/count; the feature-004 resolve endpoint moved behind `DashboardTokenGuard`.

**Frontend (Session 2)** — four operator surfaces, all live via TanStack Query
`refetchInterval` polling (no SSE, no bearer in any URL): the needs-human queue
(resume / done_manually / dismiss + history) with a live navbar open-task badge
and the `open > 0` landing rule; the run/ticket card (✅/❌/⚠/⏭ report checklist
with expandable reasons, event timeline, run history, failure diagnostics,
cancel/retry); the workspace runs table (agent/status/ticket filters,
pagination, cost header with 24h/7d/30d presets, row → card); executors admin in
Workspace Settings (typed `ExecutorForm` modal driven by the shared
`executor.schema` union, list/create/update/delete with the in-use 409
surfaced) plus the enabled/pause Start/Pause control and a Running/Paused status
column in the workspace list. The agent form's executor picker now reads the
real `/executors` (names + type badge, defaults to the workspace's `claude_cli`
executor, never a raw UUID). Component tests are msw + `@vue/test-utils` extending
`apps/web/test/{mount,handlers}.ts` — no live backend needed.

### No structural schema change (two additive items only)

1. One additive index `runs_workspace_created` on `(workspace_id, created_at
   desc)` — committed migration + reviewed SQL (constitution rule #5).
2. The enabled/pause flag lives in `workspaces.settings` jsonb
   (`settings.enabled`; absent ⇒ enabled) — no DDL. Session 2 extended the
   shared `WorkspaceSettingsRequestSchema` with an optional `enabled` (the write
   path, which flows through `patchWorkspaceSettings`) and added `enabled` to
   `WorkspaceResponse` (mapped in the backend `toResponse` from settings) so the
   Start/Pause control reflects and writes the persisted state.

### Live pass

Checkpoint (2026-07-13, live dev stack): token gate → workspaces landing;
Runs tab filters/cost header/empty state; executors admin lists the live
workspace's custom-named executors (type-scoped backfill is a no-op — no
duplicate defaults); the executor edit form round-trips typed config; **live
concurrency re-apply proven on the running worker** (`concurrency_limit` 1→2
via the UI → worker log `run.claude_cli concurrency: 2 (was 1)` within one
15 s tick, no restart → reverted); agent-form executor picker defaults to the
claude_cli executor by NAME (no UUIDs, never empty); human queue renders with
its empty state; unauthenticated API calls → 401. Checkpoint fix landed the
same day: PipelineService / HumanTaskService / ResumeService moved off the
global LIMIT-1 Jira client onto per-workspace `forWorkspace` resolution (the
write-path half of multi-workspace, missed by the 006 spec's US5 scope).

**Deferred to iteration 9 step 0 (decision 2026-07-13)**: the write-path live
scenarios — agent-via-UI + mock test-run with a real Jira transition/comment
(gates T158/T070), the first live `claude_cli` run (T091), and the callback
run request_human → queue → resume (T117) — plus journal gate entries
T071/T092/T118/T159 and the T055 checkbox. They need a sacrificial board
ticket and run at the start of the migration iteration, where live agent runs
happen anyway. All static gates (`pnpm typecheck && pnpm lint && pnpm test`,
the web package's `vue-tsc`, 38 msw component tests, 181 integration) green.

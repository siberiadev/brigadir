# Feature Specification: Pipeline Skeleton — Monorepo, Database, Queues, Mock Executor

**Feature Branch**: `001-pipeline-skeleton`

**Created**: 2026-07-10

**Status**: Draft

**Input**: User description: "Iteration 1 from docs/plan-internal.md — Skeleton: monorepo, DB, queues, mock executor. Establish the orchestration foundation: run persistence, per-executor queues with dedup and backoff, a deterministic mock executor covering all outcome scenarios, validated agent configuration, one-command local environment, and integration tests proving the run lifecycle without real Jira or LLMs."

**Normative sources** (this spec derives from, and defers to, these documents):
`docs/plan-internal.md` (iteration 1 row, "Принятые решения"), `docs/spec.md` §0.1 / §0.5 (worker settings intro + error classification) / "Сквозные NFR" item 5, `docs/architecture.md` §3 (Postgres schema — implement as-is, do NOT redesign) and §4 (AgentExecutor contract, exitStatus → run status mapping), `.specify/memory/constitution.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Lifecycle with Deterministic Outcomes (Priority: P1)

As a BRIGADIR developer, I can trigger a run for a (ticket, agent) pair and watch it travel the full pipeline — queued, picked up by a worker, executed by a deterministic mock executor, and recorded with the correct terminal status — for every possible execution outcome, without any real Jira or LLM involved.

**Why this priority**: This is the spine of the whole product. Every later iteration (Jira ingest, real executors, callbacks, UI) plugs into this run lifecycle; if run state transitions are wrong here, everything downstream inherits the defect.

**Independent Test**: Insert workspace/executor/agent/ticket fixtures, enqueue one run per mock scenario, and assert the persisted run record reaches the expected terminal status for each scenario — fully automated, no external services.

**Acceptance Scenarios**:

1. **Given** a queued run whose mock scenario is `success`, **When** the worker processes it, **Then** the run record ends `succeeded` with a schema-valid report, outcome `success`, and recorded start/finish times.
2. **Given** a queued run whose mock scenario is `failure`, **When** the worker processes it, **Then** the run ends `failed` with outcome `failure` and per-check statuses preserved.
3. **Given** a queued run whose mock scenario is `needs_human`, **When** the worker processes it, **Then** the run ends in the awaiting-human state and a human task record is created for it.
4. **Given** a queued run whose mock scenario is `timeout`, **When** the worker processes it, **Then** the run ends `timed_out` with diagnostics recorded.
5. **Given** a queued run whose mock scenario is `crash`, **When** the worker processes it and retry attempts remain, **Then** the same run record returns to `queued` with its attempt counter incremented; **When** attempts are exhausted, **Then** the run ends `failed`.
6. **Given** a queued run whose mock scenario is `rate_limited`, **When** the worker processes it, **Then** the job returns to the queue, the run stays active, and the attempt counter is NOT consumed; a later pass completes the run normally.

---

### User Story 2 - No Duplicate Active Runs (Priority: P2)

As a BRIGADIR operator, when the same trigger fires more than once for the same ticket and agent (replayed events, races, manual re-triggers), the system never starts a second concurrent run for that pair.

**Why this priority**: Runs are non-idempotent and expensive (real executors cost money and mutate repositories). Duplicate-run protection is a constitutional guarantee (Principle II) and must exist before any real trigger source is connected in iteration 2.

**Independent Test**: Enqueue the same (ticket, agent) run twice — sequentially and concurrently — and assert exactly one active run record exists and exactly one execution happens.

**Acceptance Scenarios**:

1. **Given** an active run for (ticket T, agent A), **When** a second enqueue for (T, A) arrives, **Then** no second active run record is created and no second job executes.
2. **Given** two concurrent enqueue attempts for the same (T, A) racing at the database level, **Then** exactly one run record is inserted; the loser observes "already exists" and skips gracefully (no crash, no orphan job).
3. **Given** a finished run for (T, A), **When** a new trigger arrives, **Then** a new run IS created — protection applies only to active runs (queued / running / awaiting-human).

---

### User Story 3 - Fail-Fast Validated Agent Configuration (Priority: P3)

As a team member defining agents, I describe the workspace, executors, and agents in a single configuration file; if the file is invalid the system refuses to start and tells me exactly what is wrong and where.

**Why this priority**: The config file is the only way to define agents until the UI (iterations 6–7). A silently mis-loaded config would send runs to wrong queues or wrong statuses; a clear startup error costs seconds to fix.

**Independent Test**: Start the application against valid and deliberately broken config files and assert startup success or a refusal that names the offending field.

**Acceptance Scenarios**:

1. **Given** a valid configuration file, **When** the application starts, **Then** workspace, executors, and agents are loaded and available to the pipeline.
2. **Given** a config with a missing required field, a wrong type, or an agent referencing an undefined executor, **When** the application starts, **Then** it exits with a non-zero status and an error message identifying the file, the field path, and the violation.
3. **Given** a config file that is absent or unparseable, **When** the application starts, **Then** it refuses to start with a clear message (no partial boot).

---

### User Story 4 - One-Command Local Environment (Priority: P3)

As a new team member, I can clone the repository and bring up the entire stack — database, queue broker, backend, worker — with one command, with the database schema applied automatically from scratch, following a README that takes at most 15 minutes.

**Why this priority**: The team (not one person) will operate and extend BRIGADIR; onboarding friction directly gates every later iteration's "поtыкать флоу" checkpoints.

**Independent Test**: On a machine with only the container runtime installed, follow the README from `git clone` to a healthy running stack and time it.

**Acceptance Scenarios**:

1. **Given** a fresh checkout and empty volumes, **When** the operator runs the single startup command, **Then** all four services start and report healthy, and all schema migrations apply to the empty database without manual steps.
2. **Given** a running stack, **When** the operator restarts only the backend, **Then** the worker process and any in-flight runs are unaffected (separate processes by design).
3. **Given** the README, **When** a developer unfamiliar with the project follows it, **Then** they reach a green integration-test run in ≤ 15 minutes.

---

### Edge Cases

- **Worker dies mid-run**: a job whose worker vanished is NOT silently re-executed (runs are non-idempotent); it surfaces as an explicit failure rather than a stalled retry.
- **Graceful shutdown during an active run**: on shutdown signal the worker stops taking new jobs and waits (bounded) for in-flight processing to settle; nothing is left half-recorded.
- **`needs_human` blocks re-trigger**: a run waiting for a human is still "active" — a new trigger for the same (ticket, agent) must be rejected by the duplicate guard.
- **Reconcile schedule re-registration**: repeated startups re-register the recurring reconcile job idempotently (upsert semantics) — no duplicate schedules accumulate.
- **Retry does not create rows**: a retried job reuses the same run record (attempt counter increments); new run rows come only from new triggers (or, later, human-task resume).
- **Terminal-state writes are idempotent**: finalizing an already-finalized run must not overwrite its terminal status.
- **Duplicate enqueue with different payload**: dedup is keyed by (ticket, agent) identity, not payload equality — a second trigger with different event data is still deduplicated while a run is active.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The codebase MUST be a single workspace-managed monorepo with three units: a backend application, a worker application (same framework project, separate entrypoint/process so the backend can restart without killing long runs), and a shared contracts package holding the validation schemas (report schema v1, callback tool schemas, agent configuration schema) used by both.
- **FR-002**: The system MUST persist all nine orchestration entities from `docs/architecture.md` §3 — workspaces, executors, agents, tickets, runs, run_checks, run_events, human_tasks, webhook_events — via versioned migrations that apply cleanly to an empty database, implementing that schema **as-is** (columns, defaults, indexes; no redesign).
- **FR-003**: The runs storage MUST enforce, at the database level, at most one active run (queued / running / awaiting-human) per (ticket, agent) pair — the `runs_one_active` partial unique index — and the enqueue path MUST treat a uniqueness violation as "run already exists", not as an error.
- **FR-004**: The system MUST maintain one job queue per executor type, with each queue's global concurrency taken from the executor's configured limit.
- **FR-005**: Enqueueing a run MUST carry a deduplication identity of `ticketId:agentId` so the queueing layer rejects duplicates while a matching job is active (second idempotency level, complementing FR-003's database guard).
- **FR-006**: The system MUST provide a mock executor implementing the `AgentExecutor` contract (`docs/architecture.md` §4: `run(ctx, signal)` → `ExecutorResult`, plus `healthCheck()`) whose behavior is deterministically selected by run/job data among exactly six scenarios: `success`, `failure`, `needs_human`, `timeout`, `rate_limited`, `crash`. Given the same inputs it MUST produce the same outcome every time (NFR "Тестируемость", item 5).
- **FR-007**: The worker MUST map executor results to run statuses exactly per `docs/architecture.md` §4: `completed` → terminal status derived from the report outcome (`succeeded` / `failed` / awaiting-human), `crashed` → `failed` with backoff retries while attempts remain, `timeout` → `timed_out`, `rate_limited` → job re-queued with the run left active, `cancelled` → `cancelled`.
- **FR-008**: A `rate_limited` outcome MUST pause the affected queue for a back-off interval and MUST NOT consume a retry attempt; a `crashed` outcome MUST consume an attempt and retry with exponential backoff (custom backoff strategy registered — a stub implementation is acceptable this iteration) up to the agent's `max_attempts`, reusing the same run record with an incremented attempt counter.
- **FR-009**: Runs that end `needs_human` MUST produce an open human task record linked to the run and leave the run in the awaiting-human (active) state.
- **FR-010**: The worker MUST register a recurring reconcile job via idempotent scheduler upsert; this iteration its handler is an intentional no-op ("empty sweeper") that runs and logs without side effects.
- **FR-011**: Worker queue settings MUST reflect the non-idempotency of runs per `docs/spec.md` §0.5: a stalled job is never silently re-processed (stall tolerance zero — explicit failure instead), the queue connection never gives up retrying the broker on its own, and completed/failed job records are retained with bounded counts (1000 / 5000).
- **FR-012**: Both applications MUST shut down gracefully: on termination signal the worker closes its queue consumers (waiting for in-flight job processing) and the backend releases resources via framework shutdown hooks; shutdown MUST NOT corrupt run records.
- **FR-013**: On startup the system MUST load the agent configuration file (`agents.yaml`, format per `docs/spec.md` §0.1: workspace + named executors + agent list) and validate it against the shared schema; any invalid or missing configuration MUST abort startup with a non-zero exit and an error identifying the offending field/path. Cross-references (agent → executor name) MUST be validated too.
- **FR-014**: The repository MUST include a compose file that boots the full stack — database, queue broker, backend, worker — with a single command, applying migrations automatically.
- **FR-015**: The repository MUST include integration tests, runnable without real Jira or any LLM, that cover: (a) each of the six mock scenarios reaching its expected terminal/active run status; (b) duplicate enqueue for the same (ticket, agent) producing no second active run, including a concurrent race; (c) the `rate_limited` scenario re-queuing without consuming an attempt.
- **FR-016**: The repository MUST include a README with local setup instructions completable in ≤ 15 minutes, and a `docs/progress.md` progress journal with iteration 1's status recorded.

### Key Entities

*(Full column-level definitions are normative in `docs/architecture.md` §3; listed here for scope.)*

- **Workspace**: one connection to a Jira project; owns all other entities; holds encrypted credentials and settings.
- **Executor**: a configured way to execute agents (type, non-secret config, encrypted secrets, concurrency limit).
- **Agent**: a pipeline participant — instruction, trigger/success/failure statuses, behavior options, timeout, budget, max attempts; references an executor.
- **Ticket**: cached mirror of a Jira issue (key, summary, last-seen status/updated) — a diff cache, never a source of truth (Constitution I).
- **Run**: one execution of an agent against a ticket — status lifecycle, attempt counter, trigger event, cost/usage, structured report, outcome; guarded by the one-active-run index.
- **RunCheck**: one named check from a run's report (pass/fail/skip/warn + reason); feeds future checklists.
- **RunEvent**: timeline entry for a run (progress, log, error, …).
- **HumanTask**: a "needs a person" work item linked to a run and ticket (kind, title, blocking flag, resolution lifecycle).
- **WebhookEvent**: inbound event dedup ledger (unique per workspace + external identifier) — table created now, populated from iteration 2.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the six mock execution scenarios produce their expected run status in automated integration tests, and results are identical across repeated test runs (determinism).
- **SC-002**: After N duplicate triggers (sequential or concurrent) for the same ticket-and-agent pair, exactly 1 active run exists and exactly 1 execution occurred, for all tested N ≥ 2.
- **SC-003**: A rate-limited execution completes on a later pass with its attempt counter unchanged from before the rate-limit event.
- **SC-004**: From a fresh clone with empty data volumes, one command brings up all four services healthy with the full schema applied — zero manual migration or setup steps.
- **SC-005**: Every tested invalid configuration (missing field, wrong type, dangling executor reference, unparseable file) aborts startup with a non-zero exit and an error naming the offending location — 0 partial boots.
- **SC-006**: A developer new to the project reaches a green integration-test run by following the README in ≤ 15 minutes.
- **SC-007**: Restarting the backend process leaves the worker process and its in-flight jobs untouched (0 interrupted runs caused by backend restarts).

## Assumptions

- **Fixed stack**: TypeScript strict / NestJS 11 / BullMQ 5 / Postgres 16 / Redis (queues only) / pnpm are constitutional constraints (Technology Constraints section), not open design choices; naming them here is a constraint reference, not implementation leakage.
- **ORM/migration tool** (Drizzle vs TypeORM per `docs/spec.md` §0.1 "choose at start, then never change") is deliberately deferred to the planning phase; whichever is chosen, FR-002's "schema as-is" rule wins over ORM conventions.
- **Mock scenario selection** is driven by data on the enqueued job/run (e.g., a scenario marker in the trigger event payload); the exact carrier field is a planning decision, but it must not require schema changes to `docs/architecture.md` §3.
- **No Jira anywhere**: ticket rows in this iteration are test fixtures; `tickets`/`webhook_events` exist for schema completeness. The `jira_*` workspace fields are filled with placeholder values from config.
- **Trigger source**: runs in this iteration are triggered programmatically (test harness / internal service call), since IngestModule arrives in iteration 2.
- **Timeout scenario semantics**: the mock's `timeout` scenario simulates the executor-level timeout result (fast), not a real multi-minute wait; wall-clock timeout enforcement details belong to the real executor iteration.
- **Encrypted credential fields** (`workspaces.jira_credentials`, `executors.secrets`) are created per schema; actual encryption/decryption machinery is exercised from iteration 2 when real credentials appear. Placeholder bytes are acceptable now.
- **Dashboard/API surface**: none required this iteration beyond what tests need; the backend app boots, runs migrations, loads config, and exposes health.

## Out of Scope (explicitly deferred)

- JiraModule and any Jira HTTP calls; webhook endpoint handling and reconciliation logic (iteration 2 — the reconcile job exists but is an empty stub).
- Real `claude_cli` executor and any LLM invocation (iteration 3).
- CallbackModule, MCP server, run JWTs, Stop-hook, secret scrubber (iteration 5).
- Web UI (iterations 6–7).
- `anthropic_api` / `deepseek_api` executor implementations (cut per `docs/plan-internal.md`; the executor abstraction still accommodates them).

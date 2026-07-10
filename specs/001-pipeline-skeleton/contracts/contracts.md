# Contracts: Pipeline Skeleton (001)

Interfaces this iteration exposes to future iterations and to tests. All zod
schemas live in `packages/contracts` (plain TS, no Nest deps) — the single
typed source per the constitution's Technology Constraints.

## C1. `AgentExecutor` (TypeScript interface, `libs/executors`)

Verbatim from `docs/architecture.md` §4, with one additive change (research F1):

```ts
export interface AgentExecutor {
  readonly type: 'mock' | 'claude_cli' | 'anthropic_api' | 'deepseek_api' | 'claude_routines';
  run(ctx: RunContext, signal: AbortSignal): Promise<ExecutorResult>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```

`RunContext` and `ExecutorResult` exactly per §4 (`workspaceDir: null` for the
mock; `callback` filled with placeholder values until iteration 5).
`ExecutorResult.exitStatus ∈ completed | crashed | timeout | rate_limited | cancelled`;
mapping to `runs.status` is the pure function specified in
[research.md](../research.md) D4 — unit-tested exhaustively.

**Mock-specific channel**: because `complete_task` callbacks don't exist until
iteration 5, `MockExecutor` returns the structured report in-band
(`ExecutorResult` extended internally with `report?: unknown`, validated by
`ReportSchema` in the processor — same validation gate future callback
reports will pass through).

## C2. `ReportSchema` v1 (zod, `packages/contracts`)

JSON Schema normative form: `docs/architecture.md` §6
(`https://brigadir.dev/schemas/agent-report/v1.json`). The zod version must
round-trip the same constraints: `schema_version: literal(1)`,
`outcome: enum['success','failure','needs_human']`, `summary ≤ 2000`,
`checks ≤ 50` items (`name ≤ 200`, `status ∈ pass|fail|skip|warn`,
`reason ≤ 1000`), optional `human_task` (**required when
outcome=needs_human** — `superRefine`), optional `artifacts`,
`additionalProperties: false` (zod `.strict()`).

## C3. `CallbackTools` (zod, `packages/contracts`)

Shapes only this iteration (consumed by nothing until iteration 5, but part
of the contracts package deliverable per spec FR-001):
`report_progress`, `request_human`, `complete_task` exactly per
`docs/architecture.md` §5.

## C4. `AgentsConfigSchema` (zod, `packages/contracts`)

YAML shape per `docs/spec.md` §0.1:

```yaml
workspace: { jira_site: url, project_key: string, repo: string, default_branch: string }
executors: { <name>: { type: 'mock'|'claude_cli'|'claude_routines'|..., concurrency: int>=1, ...type-specific } }
agents:
  - name, executor (must reference executors key), instruction,
    trigger_status?, status_running?, status_success, status_failure,
    timeout_minutes (default 45), max_budget_usd?, max_attempts (default 2),
    behavior? { branch_prefix?, allowed_tools?, required_checks? }
```

Failure contract: invalid file ⇒ startup aborts, exit code ≠ 0, error message
contains the file path and the zod issue path (e.g.
`agents[0].executor: references unknown executor "clod-sub"`).

## C5. Queue job contract (`libs/queues`)

- **Queue names**: `run.<executorType>` (iteration 1: `run.mock`) and `reconcile`.
- **Job name**: `run`; **payload**: `{ runId: string }` — nothing else, ever
  (processor re-reads state from Postgres; scenario data lives in
  `runs.trigger_event`).
- **Enqueue options**: `deduplication: { id: '<ticketId>:<agentId>' }`,
  `attempts: agent.max_attempts`, `backoff: { type: 'custom' }`.
- **Worker options**: `maxStalledCount: 0`; connection
  `maxRetriesPerRequest: null`; `removeOnComplete: {count: 1000}`,
  `removeOnFail: {count: 5000}`; `settings.backoffStrategy` = stub
  exponential (research D3).
- **Reconcile**: `upsertJobScheduler('reconcile', { every: 300_000 })`, no-op
  handler logging one event.

## C6. Trigger API (internal service, no HTTP this iteration)

`RunTriggerService.trigger({ ticketId, agentId, triggerEvent })`:
1. INSERT `runs` (status `queued`, attempt 1) — unique violation on
   `runs_one_active` caught ⇒ return `{ deduplicated: true, existingRunId }`.
2. `queue.add(...)` per C5.
Tests and (later) IngestModule call this one entrypoint — it is the seam
where iteration 2's `onStatusChanged` plugs in.

## C7. Operational contracts

- **Backend HTTP**: `GET /health` → `200 {status:'ok', db:'up', redis:'up'}` (compose healthcheck target).
- **docker-compose**: services `postgres` (16), `redis` (7), `backend`, `worker`; single `docker compose up` from fresh volumes reaches all-healthy; migrations run by backend on boot before health turns ok; `stop_grace_period: 35s` on worker.
- **Env**: `DATABASE_URL`, `REDIS_URL`, `AGENTS_CONFIG_PATH` (default `./agents.yaml`), `PORT` (backend). `.env.example` committed.

# Phase 0 — Research: Runs Visibility & Human Queue

All decisions below resolve the `NEEDS CLARIFICATION` / planning-decision items the
spec deferred to `/speckit-plan`. No open unknowns remain at the end of Phase 0.

The governing bias, stated in the spec and reaffirmed here: **this is an internal
tool for a small trusted team — choose the simplest mechanism that meets "reflects
changes within a few seconds" and the constitution, not the most scalable one.**

---

## R1 — Live-update transport (spec Edge Case "Live-update transport"; FR-031, FR-005, FR-014, FR-017)

**Decision**: **Client-side polling via TanStack Query `refetchInterval`** (~3 s for the
open-task count badge and an open run card; ~4–5 s for the runs table while the tab is
focused). No server push, no new streaming endpoint, no SSE.

**Rationale**:
- `EventSource` cannot set an `Authorization` header, and the project privacy rule
  forbids the bearer in a query string — so raw SSE (the prior spec's assumption) is
  off the table without extra machinery.
- The two header-capable alternatives each add real surface for no operator-visible
  gain at this scale:
  - *Fetch streaming (SSE-over-fetch)* needs a server-side event bus, a long-lived
    streaming controller, and heartbeat/reconnect handling on the client.
  - *Short-lived SSE ticket endpoint* needs a ticket mint endpoint, a ticket store with
    expiry, and a second auth path parallel to the bearer guard — more code and a new
    credential to reason about (Principle V surface) for the same result.
- Polling reuses the **exact** existing auth path: every refetch is an ordinary
  `Bearer`-authenticated `GET` through `DashboardTokenGuard` and the shared `apiClient`.
  Nothing new to secure, and `refetchInterval` is already a first-class TanStack Query
  feature the codebase depends on (feature 005 composables).
- "Within a few seconds without a manual refresh" is fully satisfied by a 3–5 s
  interval. The dataset is tiny (one team's runs), so the query cost is negligible.

**Tuning to keep it cheap and correct**:
- Set `refetchOnWindowFocus: true` and pause intervals on hidden tabs
  (`refetchIntervalInBackground: false`, TanStack default) so a backgrounded dashboard
  is not polling.
- Scope the fastest interval to *live* data: the badge (always mounted) and an **open**
  run card. Terminal run cards and the history filter do not need a live interval.
- The runs table refetch is keyed by its active filters/page, so live updates land on
  the currently-viewed slice only.

**Alternatives considered**: fetch-streaming SSE (rejected: server event bus + reconnect
complexity, no benefit at this scale); SSE ticket endpoint (rejected: extra endpoint +
ticket store + second credential path); WebSocket (rejected: heaviest, needs its own auth
handshake). All three are re-openable later behind the same composables if scale ever
demands it — the query hooks are the seam.

**Consequence for FR-031**: satisfied — no bearer in any URL, fully compatible with the
static-bearer guard, single mechanism across table/card/badge.

---

## R2 — Multi-workspace reconcile with a per-workspace Jira client (FR-026, FR-027, FR-028, FR-029)

**Decision**: Change `ReconcileService.run()` from a single `workspaces LIMIT 1` selection
to **iterate every enabled workspace**, and thread a **per-workspace `JiraClient`
(resolved via `JiraClientFactory.forWorkspace(ws.id)`) as an explicit parameter** through
the four pass steps, instead of relying on the constructor-injected global `JIRA_CLIENT`.

**Shape**:
```
run():
  wsRows = select enabled workspaces      # R3 defines "enabled"
  for ws in wsRows:                        # each ws fully isolated
    try:
      jira = jiraClientFactory.forWorkspace(ws.id)   # cached+fingerprinted (005 R6)
      boardType = ensureBoardType(ws, jira)          # skip pass on introspection failure
      ctx = { ...ws, boardType }
      step('poll & diff',        () => poller.pollAndDiff(ctx, jira))
      step('dependency re-eval', () => reEvaluateDependencies(ctx, jira))
      step('watchdog',           () => watchdog.sweep(ctx))          # no Jira calls today
      step('drift repair',       () => drift.repair(ctx, jira))
    catch err:
      log(`workspace ${ws.id}: reconcile pass failed (others continue): ${err}`)
      continue
```

**Rationale**:
- The global `JIRA_CLIENT` resolves `workspaces LIMIT 1` (the iteration-2 single-workspace
  memo). With 2+ workspaces it authenticates every call against the wrong site — the exact
  hazard `JiraClientFactory.forWorkspace` was built to close for the dashboard (005 R6).
  The worker must use the same per-workspace factory.
- Passing the client as a **parameter** (rather than injecting it) is the minimal, honest
  change: `PollerService`, the dependency re-eval, and `DriftRepairService` each already
  take a `WorkspaceContext`; they gain one more argument (`jira: JiraClient`) and drop the
  constructor `@Inject(JIRA_CLIENT)`. This keeps per-workspace credential resolution
  explicit and lazy (constitution tech-constraint: no eager/global credential binding).
- Two isolation layers protect the loop: a **per-workspace** try/catch (a whole
  workspace's Jira outage, credential decode failure, or board-introspection failure is
  logged and that workspace is skipped for the pass) **and** the existing **per-step**
  try/catch inside a workspace. FR-029 needs the per-workspace layer specifically — a
  throw while *resolving the client or board type* (outside the four steps) must not abort
  the loop.
- `getReconcileState` / `setReconcileState` and `getScopeJql` are already keyed by
  `ws.id`, so per-workspace HWM, sprint state, and scope JQL work unchanged.

**Provisioning note (constitution tech-constraint — lazy resolution)**: `JiraClientFactory`
lives in `libs/jira` and is currently provided for the dashboard/statuses paths. It must be
exported from the worker-side `JiraModule` provider set so `ReconcileService` can inject it.
It reads credentials lazily inside `forWorkspace` (DI method call at pass time), never at
module composition — compliant.

**Alternatives considered**: keep injecting `JIRA_CLIENT` and swap the memo key per
workspace inside the loop (rejected: mutating a shared memoized singleton mid-loop is
exactly the stale-client footgun 005 R6 warns about); spawn one BullMQ job per workspace
(rejected: adds a fan-out/scheduling layer and cross-job ordering concerns for no benefit —
a single pass iterating N small workspaces is trivial and keeps the existing scheduler).

---

## R3 — Where the workspace "enabled / paused" flag lives (FR-028, FR-030) — **schema discrepancy resolved**

**Finding**: The spec's Key Entities and Assumptions claim the workspace `enabled` flag is
existing data and "no schema migration is required." **It is not.** `libs/database/src/
schema/workspaces.ts` has **no `enabled` column** (columns: name, jira_site_url,
jira_project_key, jira_board_id, jira_board_type, jira_auth_type, jira_credentials,
jira_credential_expires_at, settings jsonb, timestamps).

**Decision**: Store the flag in the existing **`workspaces.settings` jsonb** as
`settings.enabled` (a boolean), **defaulting to `true` when absent**. No DDL, no migration —
honoring the spec's "no schema change" claim and constitution rule #5 (schema in
architecture §3 not changed without updating the doc). `settings` already carries
`repositories[]` (feature 005), so this is the established home for non-indexed
workspace config.

**Rationale**:
- Adding a real `boolean enabled` column would be cleaner in isolation but triggers the
  full constitution rule-#5 ceremony (migration in `drizzle/`, architecture §3 update, SQL
  review) for a single low-traffic boolean the reconcile pass reads once per pass — not
  worth it for an internal tool, and it contradicts the spec's stated no-migration intent.
- "Enabled unless explicitly disabled" (absent ⇒ true) means every already-created
  workspace stays polled with zero backfill.
- The reconcile pass filters in application code
  (`settings->>'enabled' is distinct from 'false'`, or filter after select) — the
  workspace count is tiny, so a jsonb predicate/scan is free. No index needed.

**Consequence**: FR-028 (disabled skipped entirely) and FR-030 (settings toggle) are met
by reading/writing `settings.enabled`. The `WorkspaceSettings` contract type
(`packages/contracts`) gains an optional `enabled?: boolean`. If a future feature needs to
index or heavily query this, promoting it to a column is a clean, separate migration.

---

## R4 — Live concurrency re-apply without a worker restart (FR-025, SC-008)

**Decision**: Add a **worker-side periodic re-apply** of `executors.concurrency_limit` to
each live BullMQ `Worker`, on a short interval (~15 s), reusing the existing
`applyExecutorConcurrency(db, worker, type, logger)` helper. Keep the boot-time apply as-is;
the periodic sweep is the "no restart" path.

**Mechanism**: Each run processor (`RunProcessor` for `mock`, `ClaudeCliRunProcessor` for
`claude_cli`) already implements `OnApplicationBootstrap` and calls
`applyExecutorConcurrency` once. Extend each to register a `setInterval` in
`onApplicationBootstrap` that re-invokes `applyExecutorConcurrency` for its own type, and
clear it on `onModuleDestroy`. `applyExecutorConcurrency` already sums all rows of a type
(matching the "sum of limits" edge case) and only writes when the total > 0, so re-applying
is idempotent and cheap (one aggregate query per type per tick).

**Rationale**:
- This is a **cross-process** requirement: the dashboard (backend process) writes the
  executor row; the live `Worker` instances live in the **worker** process. The two share
  only Postgres and Redis. The simplest correct bridge is the worker re-reading its own
  source of truth (the `executors` table) on a timer — no new pub/sub, no new Redis key,
  no coupling to the 5-minute Jira reconcile pass (which must not gate concurrency on Jira
  availability).
- `worker.concurrency = N` on a running BullMQ worker takes effect immediately for the next
  slot acquisition; no restart. A ~15 s interval satisfies "takes effect on the live worker
  without a restart" with a comfortably small lag.
- Per-processor placement keeps each type's re-apply local to the processor that owns that
  `Worker` instance and needs no registry of workers.

**Alternatives considered**: Redis pub/sub signal from the backend on executor write
(rejected: new channel + subscriber lifecycle for a rarely-changed number); piggyback on the
reconcile pass (rejected: couples concurrency to Jira health and to the 5-min cadence);
BullMQ `QueueEvents`/job to trigger re-apply (rejected: heavier than a timer for a value
that changes by hand). All keep the same `applyExecutorConcurrency` core, so switching later
is trivial.

**Test note (Principle VI)**: executor lifecycle + concurrency mapping is pipeline logic and
must be tested same-iteration — an integration test changes a row's `concurrency_limit`,
waits one interval (or invokes the re-apply directly with a short interval), and asserts
`worker.concurrency` reflects the new sum.

---

## R5 — Executors CRUD, typed per-type config, and default seeding (FR-020..FR-024)

**Decision**: Add an `ExecutorsController` at `/api/workspaces/:id/executors` (list, create,
update, delete), guarded by `DashboardTokenGuard`, with a **discriminated-union config
schema per executor type** in `packages/contracts` (single typed source). Seed the default
executor set inside the **existing workspace-create path** (feature 005
`WorkspacesController.create`), not a migration.

**Per-type config (contract, `packages/contracts/src/executor.schema.ts`)**:
- `mock`: `{ concurrency_limit }` only.
- `claude_cli`: `{ model, cli_path, repository (one of the workspace's settings.repositories
  names), use_callback_channel (bool), keep_failed_worktrees (bool), max_turns,
  concurrency_limit }`.

The union discriminates on `type`; the server validates the submitted config against the
matching member and rejects unknown/foreign fields (so a `mock` cannot carry `max_turns`).
`concurrency_limit` maps to the `executors.concurrency_limit` **column**; the rest map into
the `executors.config` **jsonb** (no schema change — both already exist).

**Seeding (FR-022)**: on workspace create, insert exactly one `claude_cli` executor named
`"claude"` and one `mock` named `"mock"` with sensible defaults; the `claude_cli` default
`repository` is the workspace's default repository when one exists (spec Assumption). The
`executors_workspace_name` unique index makes re-seeding safe (insert-if-absent).

**Backfill for pre-006 workspaces (FR-023 "never empty", checkpoint addition)**: create-time
seeding alone leaves a workspace created *before* this feature with zero executors showing an
empty picker. Close the gap with a **one-shot backfill at backend bootstrap**: iterate all
workspaces and, **per executor type**, insert the default executor only when the workspace has
**no executor of that type at all** (NOT name-based insert-if-absent — a live workspace whose
executors carry custom names, e.g. `claude-cli`/`mock-exec`, must not gain duplicate defaults,
which would also inflate the per-type concurrency sum). Existing rows are never modified. This
runs in the backend's `OnApplicationBootstrap`, is a no-op on every boot after the first, and
avoids a GET endpoint that writes. Create-time seeding may keep the simpler name-based
insert-if-absent (a fresh workspace has no rows to collide with).

**Delete guard (FR-024, SC-009)**: reject deletion of an executor referenced by any agent
with a clear, actionable error naming the conflict. Agents reference an executor — confirm
the FK/column during design (`agents.executorId` or by `executor_type`); the guard is a
pre-delete `count(*)` of referencing agents → `409 Conflict` with the agent name(s) when > 0.

**Rationale**: The agent form's executor picker is currently blocked on a fresh workspace
(the discovery workaround returns nothing) — seeding + a real list endpoint is the
foundational fix (US4 "never see an empty picker"). Keeping config typed in
`packages/contracts` means the backend authority and the Vue form share one schema
(constitution single-typed-source), mirroring feature 005's linter pattern.

**Alternatives considered**: seed via a DB migration (rejected: seeding is per-workspace and
must run for every future wizard-created workspace, not once); free-form `config` jsonb with
client-only validation (rejected: violates single-typed-source and lets a `mock` carry
`claude_cli` fields).

---

## R6 — Run/ticket card read model: cancel & retry reuse (FR-007..FR-013)

**Decision**: The card is a **read-only projection** plus two writes that reuse existing
paths. New endpoints:
- `GET /api/runs/:id` — the card payload: run row + `run_checks` (ordered by `position`) +
  `run_events` (ordered by `id`) + the ticket header (key, summary, Jira deep link built
  from `workspaces.jira_site_url` + `tickets.jira_key`) + the ticket's run history (all runs
  for that ticket: agent, executor, attempt, duration, cost, outcome).
- `POST /api/runs/:id/cancel` — a **guarded** `UPDATE runs SET status='cancelled' WHERE
  id=:id AND status='running'` (flip off `running` only). The worker's existing
  `cancelPoll` (`isStillActive` returns `status === 'running'`) then aborts the process and
  the executor finalizes. **Guard is mandatory** (constitution rule #7 / FR-012 / spec Edge
  Case "Cancel race"): the `WHERE status='running'` clause is what prevents overwriting an
  `awaiting_human` run.
- `POST /api/runs/:id/retry` — reuse the **existing manual-trigger path**
  (`RunTriggerService.trigger({ ticketId, agentId })`, the same call
  `agents.controller` `test-run` uses), so all three idempotency layers apply. Offer retry
  only for a finished (terminal) run whose (ticket, agent) has no active run; the
  `runs_one_active` partial unique index rejects a second active run, so the endpoint
  surfaces that as a clean `409` rather than a 500 (spec Edge Case "Retry semantics").

**Rationale**: FR-033 forbids changing run execution / callback protocol — this feature only
*reads* run/report/event data and *invokes* existing resolve/cancel/manual-trigger paths.
Cancel-as-a-status-flip is precisely how the worker's cancel poll already works
(`isStillActive`), so no worker change is needed. The report is rendered from `run_checks`
(status ∈ pass/fail/warn/skip → ✅/❌/⚠/⏭) with `reason` on expand; a report with no checks
or missing fields renders the available parts (spec Edge Case "partial report") — the read
endpoint returns whatever exists without failing.

**Failure diagnostics (FR-011, SC-003)**: for a failed run, expose `runs.error` and the
relevant `run_events` of type `error`/`log` as the stderr/diagnostics block. No new storage
— these columns/rows already exist.

**Alternatives considered**: a dedicated cancel signal (Redis/queue message) to the worker
(rejected: the status-flip poll already exists and is race-safe by the guard); denormalizing
the card into one wide response vs. a couple of joined queries (chosen: a single endpoint
doing 3–4 indexed reads — `runs_ticket`, `run_events_run`, `run_checks` by run — is simple
and fast at this scale).

---

## R7 — Runs table: filtering, pagination, and the lite cost figure (FR-015..FR-019, SC-010)

**Decision**: `GET /api/workspaces/:id/runs` returns a **paginated** list with
server-side filters: `?agent=<id>&status=<runStatus>&ticket=<key-substring>&page=&pageSize=`.
Each row: agent name, ticket key + summary + Jira deep link, run status, attempt, duration
(`finished_at − started_at`, or `now − started_at` for running), cost (`cost_usd`). Ordered
by `created_at desc`. The workspace cost figure is a separate lightweight query
`GET /api/workspaces/:id/runs/cost?period=24h|7d|30d` returning `sum(cost_usd)` over the
period — kept off the paginated query so it isn't recomputed per page.

**Rationale**: The existing `runs_ticket` index covers ticket-scoped reads; the table's
workspace-scoped, filtered, paginated read benefits from a **supporting index** on
`(workspace_id, created_at desc)` (and the filters are low-cardinality). Per spec Assumptions
("if a read query needs a supporting index, that is an implementation detail, not a schema
change"), this index is added as a Drizzle migration that is **additive and non-structural**
(no column/constraint change to architecture §3) — see data-model.md. Filtering server-side
keeps pagination honest (FR-016: "pagination reflects the filtered set"). Ticket-key search
is a case-insensitive substring on `tickets.jira_key`.

**Alternatives considered**: client-side filtering of a full fetch (rejected: breaks
pagination semantics and doesn't scale as runs accumulate); a materialized cost rollup
(rejected: over-engineered — `sum` over an indexed period on a small table is instant).

---

## R8 — Human queue read + resolve surface, and guarding the existing endpoint (FR-001..FR-006)

**Decision**: Add read endpoints and **apply the dashboard guard to the existing resolve
endpoint**:
- `GET /api/human-tasks?status=open|closed` — cross-workspace list; open items carry title,
  ticket key, agent, kind, `created_at` (for age), `blocking`, and the blocked `run_id`;
  closed items add `resolution`, `resolved_by`, `resolved_at`. Ordered oldest-open-first.
- `GET /api/human-tasks/count` (or an `X-Total`-style field on the open list) — the badge
  count of open tasks; polled per R1.
- Reuse `POST /api/human-tasks/:id/resolve` (feature 004 `ResolveController` +
  `ResumeService`) **unchanged in behavior** for resume / done_manually / dismiss. **Change:
  add `DashboardTokenGuard`** — it is currently unguarded (`// unguarded this iteration`),
  which violates FR-032 once it's a live UI surface. This is an auth addition, not a
  behavior change (FR-033 respected).

**Rationale**: FR-004's resume must drive the real feature-004 path — `ResumeService.resolve`
already supersedes the parked run and inserts the next attempt through the three dedup
layers; the UI just calls the endpoint. The queue is global (across workspaces) per US1, so
the list is not workspace-scoped, but every row still belongs to a workspace and the guard
(single shared bearer) authorizes the whole dashboard. The badge count drives FR-002
(human queue is the default landing view only when count > 0 — an empty queue shows the
empty state and does not hijack the landing route, per spec Edge Case "Empty states").

**Alternatives considered**: leaving resolve unguarded (rejected: FR-032 requires the guard
on all new/live dashboard surfaces); workspace-scoping the queue (rejected: US1 explicitly
wants one cross-workspace list).

---

## Cross-cutting confirmations

- **No run/callback protocol change** (FR-033): every write this feature performs is either
  a guarded status flip (cancel), an existing trigger call (retry), or the existing resolve
  path. Confirmed against `RunsService`, `ResumeService`, `RunTriggerService`, and the
  worker cancel poll.
- **No kanban board** (FR-034): Jira remains the only board; the runs table and card are
  run/report projections, not a board copy.
- **Auth** (FR-032): every new endpoint carries `DashboardTokenGuard`; the previously
  unguarded resolve endpoint gains it. No bearer in any URL (R1).
- **Testing pattern** (Principle VI, CLAUDE.md rule 4): backend endpoints + multi-workspace
  reconcile + concurrency re-apply use testcontainers (real Postgres/Redis) + mock-jira, no
  broker mocks; Vue views use Vitest + msw component tests, extending the feature-005
  `mount.ts` / `handlers.ts` harness.

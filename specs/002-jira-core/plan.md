# Implementation Plan: Jira Core — The Orchestrator Replaces Jira Automation

**Branch**: `002-jira-core` | **Date**: 2026-07-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-jira-core/spec.md`

## Summary

Build the Jira half of the pipeline so BRIGADIR replaces Jira Automation end
to end, closing iteration-1 deviations **F2** (run completion now transitions
the ticket + posts an ADF checklist comment) and **F3** (reconcile becomes a
real four-step job). Three new capabilities on top of the iteration-1
skeleton:

1. **`libs/jira`** — a typed Jira client over native `fetch` (REST v3 + Agile
   1.0), with a token-bucket rate limiter + global concurrency cap, per-issue
   write serialization (`p-queue` map keyed by issue key), runtime transition
   discovery with a TTL cache + 409 retry + `NoTransitionPath`, and a pure
   ADF composer (`buildRunComment`). Credentials resolve through a DI factory
   from the `workspaces` row (Constitution lazy-resolution) — never at import.
2. **`libs/ingest`** — the reconcile job as one scheduled processor running
   four ordered, independently try/caught steps sharing one pass-level Jira
   budget: (1) poll & diff (board-type scope + `scope_jql` + HWM, sprint-switch
   rescan), (2) dependency re-evaluation of gated tickets in trigger statuses,
   (3) watchdog (timeout+grace), (4) drift repair (re-apply pending Jira writes
   for already-persisted results only).
3. **`libs/pipeline`** — `onStatusChanged` (agent match by `trigger_status` +
   dependency gate → `RunTriggerService` through the existing three dedup
   layers) and `onRunFinished` (persist-then-write: transition to
   success/failure status + ADF comment).

All automated tests run against a configurable **mock Jira** (msw over
`fetch`) reusing the existing testcontainers Postgres/Redis harness. No real
Jira, no LLMs. A single manual live smoke is the DoD gate. Real `claude_cli`,
MCP callbacks, UI, and OAuth 3LO stay out of scope.

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js 22 LTS (global `fetch`, no HTTP SDK)

**Primary Dependencies**: NestJS 11 (monorepo: apps + libs), @nestjs/bullmq + BullMQ 5, Drizzle ORM + drizzle-kit (committed SQL migrations), zod, yaml; **added this iteration**: `p-queue` (runtime, per-issue write serialization) and `msw` (dev, mock Jira over fetch). No Atlassian SDK — precise control of rate limiting, headers, and mocking (fixed decision).

**Storage**: PostgreSQL 16 (system of record). One migration this iteration: `jira_board_id`, `jira_board_type` on `workspaces`. `scope_jql`, reconciliation high-water mark, and `active_sprint_id` live in `workspaces.settings` (jsonb) — no columns. Redis 7 (BullMQ queues only).

**Testing**: vitest; integration via existing `@testcontainers/postgresql` + `@testcontainers/redis` global-setup (real Postgres/Redis); **mock Jira via msw** node interceptors over `fetch` — one configurable helper in `test/integration/`. Unit: ADF composer snapshots, rate-limiter/transition-cache logic.

**Target Platform**: Linux server / macOS dev; docker-compose (postgres, redis, backend, worker) unchanged.

**Project Type**: Web service backend (control plane) + queue worker (execution plane), single Nest project, two entrypoints; new shared modules in `libs/*`.

**Performance Goals**: correctness over throughput. Jira defaults: `JIRA_MAX_RPS=5`, global concurrency cap 8; per-issue writes strictly serialized (≤ 20/2s budget honored). Reconcile every 5 min; overlap 60 s; transition-cache TTL 10 min.

**Constraints**: Constitution lazy resource resolution (Jira creds via DI factory from the workspace row — no import-time env reads, no localhost fallback); only the system writes to Jira, all writes through the per-issue queue; persist run result **before** Jira writes; runs non-idempotent (`maxStalledCount: 0`); schema change limited to the two board columns (architecture §3 already updated).

**Scale/Scope**: single workspace, single-digit agents, tens of concurrent runs — internal team tool. Single Jira writer per workspace (in-process serialization sufficient).

All architectural choices were fixed by the invoking instruction; the remaining mechanics are resolved in [research.md](research.md) (D1–D12). **No NEEDS CLARIFICATION remain.**

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.0 — pre-research and re-checked post-design. Result: **PASS**, no violations to justify.*

| Principle | Gate | Status |
|---|---|---|
| I. Dual Source of Truth | Jira is authoritative for status; `tickets.last_seen_status` is a diff cache only; HWM + `active_sprint_id` + `scope_jql` in `workspaces.settings`; all run state stays in Postgres; reconciliation is the guaranteed path (webhooks out of scope) | ✅ |
| II. Idempotency at Three Levels | Every trigger source (poller diff, scope-entry, sprint-switch rescan, dependency re-eval) routes through `RunTriggerService` → BullMQ `deduplication {id: ticket:agent}` (L2) + `runs_one_active` (L3), each tested. L1 (webhook dedup) table exists; webhook path out of scope — poller diff is idempotent by construction | ✅ |
| III. System-Only Jira Writes | All transitions/comments go through `JiraModule` per-issue write queue; no module calls Jira around it; agents write nothing (no executor this iteration). `onRunFinished` is the sole completion-write path | ✅ |
| IV. Run Completion Contract | Unchanged — `finalizeWithReport` still validates `ReportSchema` before persistence; `onRunFinished` reads the persisted report to decide the transition; repeated completion still guarded (terminal-immutable UPDATE) | ✅ |
| V. Secret Isolation & Output Scrubbing | Jira API token resolved in a DI factory into the client instance; never in argv, never logged (only `RateLimit-Reason` logged). Encryption-at-rest of credentials and the report scrubber remain iteration 2-adjacent/5 scope; no new secret surface reaches an agent (no agent runs) | ✅ (credentials structurally confined to the client) |
| VI. Test-Mandatory Pipeline Logic | Every FR on the ingest→Jira-write path ships integration tests in the same phase (see Phasing): full loop, 1-hour catch-up, per-issue serialization, 429/Retry-After, transition 409 + NoTransitionPath, board scope (scrum/kanban/sprint-switch), dependency gate, scope_jql, config forward-compat | ✅ |
| Tech Constraints (incl. lazy resolution) | TS strict / NestJS 11 / BullMQ 5 / Postgres 16 / contracts in `packages/contracts`; **JiraModule via `forRootAsync`** with creds resolved at context-init from the workspace row — no eager import-time connection, no localhost fallback (the exact iteration-1 failure this rule encodes) | ✅ |

**Post-design re-check**: design artifacts **close** iteration-1 deviations F2
and F3 rather than adding new ones. Two items are flagged for traceability in
Complexity Tracking (not constitutional violations): the reconcile job carries
four steps where architecture §4 lists three duties (dependency re-eval +
watchdog added; webhook-refresh is 3LO-only, out of scope), and the
pending-Jira-write marker is recorded as a `run_events(type='jira_action')` row
(consistent with architecture §5) rather than a new column.

## Project Structure

### Documentation (this feature)

```text
specs/002-jira-core/
├── plan.md              # This file
├── spec.md              # + 4 amendments (board scope, dep gate, scope_jql, config fwd-compat)
├── research.md          # D1–D12 decisions + deviation flags
├── data-model.md        # schema delta, settings blob shape, entities, gate/scope logic
├── quickstart.md        # validation guide (automated suite + live-smoke gate)
├── contracts/
│   └── contracts.md     # C1–C8: JiraClient, ADF, transition discovery, Pipeline, Reconcile, mock-Jira
└── checklists/requirements.md
```

### Source Code (repository root)

```text
apps/
├── backend/                 # + workspace board introspection at seed/connect (Agile board GET)
└── worker/
    └── src/
        ├── reconcile.processor.ts   # delegates to IngestModule ReconcileService (4 ordered steps)
        ├── reconcile.scheduler.ts   # unchanged (every 300_000ms)
        └── run.processor.ts         # after finalize → PipelineService.onRunFinished (persist-then-write)

libs/
├── jira/                    # NEW — JiraModule (forRootAsync, creds from workspace row)
│   └── src/
│       ├── jira-client.interface.ts     # JiraClient (REST v3 + Agile 1.0)
│       ├── basic-auth-jira.client.ts    # fetch impl; rate limiter + concurrency cap beneath writes
│       ├── rate-limiter.ts              # token bucket + concurrency cap; 429/Retry-After
│       ├── per-issue-write-queue.ts     # p-queue map keyed by issue key
│       ├── transition-discovery.ts      # GET /transitions → match by name → POST; TTL cache; 409 retry; NoTransitionPath
│       ├── adf-composer.ts              # buildRunComment(report) → ADFDoc (pure, snapshot-tested)
│       ├── jira.errors.ts               # NoTransitionPath, JiraAuthError (Unrecoverable), JiraRateLimited
│       └── jira.module.ts
├── ingest/                  # NEW — reconcile orchestration
│   └── src/
│       ├── reconcile.service.ts         # runs the 4 ordered steps, per-step try/catch, pass-level budget
│       ├── poller.service.ts            # searchUpdated (board-scope JQL + scope_jql + HWM), diff, sprint-switch rescan
│       ├── watchdog.service.ts          # timeout+grace → fail + failure-outcome treatment
│       ├── drift-repair.service.ts      # re-apply pending Jira writes (jira_action marker) — never re-drive a run
│       └── ingest.module.ts
├── pipeline/                # NEW — status machine
│   └── src/
│       ├── pipeline.service.ts          # onStatusChanged (match + dep gate → RunTriggerService); onRunFinished
│       ├── dependency-gate.ts           # inward "is blocked by" statusCategory evaluation
│       └── pipeline.module.ts
├── runs/                    # RunTriggerService unchanged (single enqueue seam through 3 dedup layers)
├── database/               # + migration 0001 (board cols); settings-blob typed accessors
├── app-config/             # config seeder now writes board_id/scope_jql; board introspection call
├── queues/                 # unchanged
└── executors/              # unchanged (mock executor drives runs)

packages/
└── contracts/              # + WorkspaceConfigSchema extension (board_id, scope_jql, branch_prefix, repositories[]);
                            #   ADF types; JiraSearchResult/IssueLink/StatusCategory types; workspace settings schema

test/
└── integration/
    ├── mock-jira.ts        # NEW — configurable msw mock (search/jql pagination, Agile board/sprint,
    │                       #        transitions incl. 409, 429+Retry-After, ADF capture, issuelinks)
    ├── jira-client.spec.ts # rate-limit, per-issue serialization, transition discovery/409/NoTransitionPath
    ├── pipeline-loop.spec.ts       # status change → enqueue → mock run → transition + ADF comment
    ├── reconcile-catchup.spec.ts   # 1-hour outage catch-up (no lost, no dup)
    ├── board-scope.spec.ts         # scrum no-sprint idle; scope-entry once; sprint switch rescan; kanban unchanged
    ├── dependency-gate.spec.ts     # blocked → no run; blocker→Done → next pass fires exactly once
    ├── scope-jql.spec.ts           # scope_jql filters triggers
    ├── watchdog-drift.spec.ts      # timeout+grace fail; pending-write re-applied; no duplicate run
    └── config-forward-compat.spec.ts  # full documented §0.1 example validates + boots

drizzle/
├── 0000_init.sql
├── 0001_jira_board.sql      # NEW (reviewed vs architecture §3 in REVIEW-0001)
└── REVIEW-0001_jira_board.md
```

**Structure Decision**: Continue the iteration-1 pattern — thin processors in
`apps/worker` delegate to injectable services in `libs/*`; `packages/contracts`
stays framework-free. Three new libs (`jira`, `ingest`, `pipeline`) keep the
client, the reconcile orchestration, and the status machine separable and
independently testable. `JiraModule` is imported via `forRootAsync` so the
credential/rate-limiter resolution happens at Nest context init, never at
module import.

## Implementation Phasing (input for /speckit-tasks)

Ordered so **integration tests land in the same phase as the capability they
prove** (Constitution VI). Each phase is independently demonstrable.

1. **Contracts + config + migration**: extend `WorkspaceConfigSchema`
   (`board_id`, `scope_jql` functional; `branch_prefix`, `repositories[]`
   validated-but-unused); add ADF/Jira/settings types; migration `0001`
   (board cols) + `REVIEW-0001` vs §3; typed `workspaces.settings` accessors.
   **Tests**: config forward-compat (full §0.1 example validates + boots);
   AgentsConfig matrix extended; migration applies from scratch. *(FR-027,
   FR-039, US6 SC-011 config half)*
2. **JiraModule client core**: `JiraClient` interface + `BasicAuthJiraClient`
   over fetch; rate limiter (token bucket + concurrency cap, 429/Retry-After);
   per-issue write queue (`p-queue` map); `forRootAsync` DI factory resolving
   creds from the workspace row; `searchUpdated` with `nextPageToken`; Agile
   `getBoard` + `openSprints`. **Tests** (msw mock-Jira helper built here):
   rate-limit honors Retry-After without burning attempts; per-issue writes
   serialized under concurrency; `/search/jql` pagination. *(FR-001–FR-004,
   FR-012 pagination, FR-028)*
3. **Transition discovery + ADF composer**: `transitionTo` (discover → match
   by name → POST), TTL cache keyed project+issuetype+fromStatus, 409
   invalidate+retry once, `NoTransitionPath`; idempotent when already in
   target; `buildRunComment` pure composer. **Tests**: 409 retry, no-path
   error, already-in-target no-op; ADF snapshots (success/failure/needs_human).
   *(FR-005–FR-009, FR-023)*
4. **PipelineModule**: `onStatusChanged` (match enabled agents by
   `trigger_status`, apply dependency gate, trigger via `RunTriggerService`);
   `onRunFinished` wired into `RunProcessor` after finalize (persist-then-write
   transition + comment; record `jira_action` marker). **Tests**: full loop on
   mock Jira for success/failure/needs_human incl. running-status transition
   and NoTransitionPath→failed; dependency gate (blocked→no run; non-blocking
   links don't gate). *(FR-018–FR-024, FR-020/021 close F2, FR-034–FR-035)*
5. **IngestModule / reconcile job**: `ReconcileService` four ordered steps with
   per-step try/catch + pass-level Jira budget; poller (board-type scope +
   `scope_jql` + HWM, sprint-switch full rescan, scope-entry-as-trigger, HWM
   persist); dependency re-evaluation of gated trigger-status tickets;
   watchdog; drift repair (re-apply pending Jira writes only, never re-drive).
   **Tests**: 1-hour catch-up (no lost/no dup); board scope (scrum idle,
   scope-entry once, sprint switch, kanban unchanged); scope_jql; dependency
   re-eval fires once on blocker→Done; watchdog timeout+grace; drift repair of
   an interrupted completion with no duplicate run. *(FR-011–FR-017,
   FR-029–FR-033, FR-036, FR-038, closes F3)*
6. **Checkpoint + live smoke (DoD gate)**: run full `pnpm typecheck && lint &&
   test && test:integration` green; execute the `quickstart.md` walkthrough;
   then the manual live smoke against a real test Jira project (bot + token) —
   one ticket trigger-status → mock run → success transition + comment; record
   the iteration-2 entry in `docs/progress.md` noting F2/F3 closed. *(FR-025,
   FR-026, SC-008–SC-011)*

**Phase-level checkpoint** sits at the start of Phase 6, before the live-smoke
gate, exactly as the plan constraints require.

## Complexity Tracking

> No constitutional violations. Table records design choices that elaborate on
> the architecture docs, flagged for traceability (details in research.md).

| Item | Why Needed | Simpler Alternative Rejected Because |
|------|------------|--------------------------------------|
| Reconcile job has 4 steps; architecture §4 lists 3 duties | Spec adds dependency re-evaluation (FR-036) and an explicit watchdog (FR-015); webhook-refresh (the 3rd §4 duty) is 3LO-only and out of scope | Folding dep re-eval into the poller diff would miss blocked tickets whose `updated` never changed; omitting the watchdog leaves NFR-1 ("no run hangs forever") unmet |
| Pending-Jira-write marker via `run_events(type='jira_action')` | Drift repair (FR-016) must know a persisted result still owes a Jira write, without a schema change | A new `runs.jira_written` column is a migration beyond the approved board columns; `jira_action` events already exist in architecture §5 and make the timeline auditable |
| `WorkspaceConfigSchema` gains `repositories[]` while keeping `repo`/`default_branch` optional | §0.1 example moved to `repositories[]`; existing `agents.yaml` still uses `repo` | Hard-removing `repo` breaks the committed seed config; keep both, `repositories[]` preferred, `repo` deprecated-optional until iteration 3 consumes it |
| F2 / F3 closed (iteration-1 flagged deviations) | This iteration's explicit purpose | n/a — closing, not adding |

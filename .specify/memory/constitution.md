<!--
Sync Impact Report
==================
Version change: 1.0.0 → 1.1.0 (2026-07-11)
Amendment: added "Lazy resource resolution" rule to Technology Constraints —
root-caused in iteration 1 (eager Redis connection in a @Module decorator
argument silently fell back to localhost:6379; see docs/progress.md,
"Post-DoD fix"). Templates unaffected.

Previous: (template) → 1.0.0 (initial ratification)
Modified principles: n/a (all principles newly defined)
Added sections:
  - Core Principles (6): I. Dual Source of Truth; II. Idempotency at Three
    Levels; III. System-Only Jira Writes; IV. Run Completion Contract;
    V. Secret Isolation & Output Scrubbing; VI. Test-Mandatory Pipeline Logic
  - Technology Constraints
  - Development Workflow
  - Governance
Removed sections: none
Templates status:
  - .specify/templates/plan-template.md — ✅ compatible (Constitution Check
    gate is populated per-feature from this document; no structural change
    needed)
  - .specify/templates/spec-template.md — ✅ compatible (no
    constitution-specific sections required)
  - .specify/templates/tasks-template.md — ✅ updated ("Tests: OPTIONAL"
    caveat amended: tests are MANDATORY for pipeline logic per Principle VI)
  - .specify/templates/checklist-template.md — ✅ compatible
Deferred TODOs: none
Source documents: docs/architecture.md (§2, §8), docs/plan-internal.md
("Принятые решения", 2026-07-10)
-->

# BRIGADIR Constitution

BRIGADIR is an orchestrator of AI coding-agent pipelines on top of Jira:
self-hosted-first, built as an internal team tool, with a later path to
multi-tenant SaaS. This constitution encodes the non-negotiable rules that
every feature, plan, and task set MUST satisfy.

## Core Principles

### I. Dual Source of Truth

Jira is the sole source of truth for ticket status; Postgres is the sole
source of truth for run history, checklists, run events, and human tasks.

- The orchestrator MUST NOT treat a ticket as being in a status it has not
  observed in Jira. `tickets.last_seen_status` is a cache for diffing —
  never authoritative.
- Run lifecycle state (`queued`, `running`, `awaiting_human`, `succeeded`,
  `failed`, `cancelled`, `timed_out`, `superseded`), reports, checks, cost,
  and timelines MUST live in Postgres. Redis holds only BullMQ queues and
  transient flags — never durable state.
- The pipeline is not described explicitly anywhere: it is emergent from
  agent trigger statuses on the Jira board. Jira webhooks provide speed;
  reconciliation polling provides the guarantee. Any feature that assumes
  a third source of truth or bypasses reconciliation violates this
  principle.

**Rationale**: A single authority per domain eliminates split-brain bugs
between the board and the database, and keeps manual intervention through
Jira fully compatible with orchestration.

### II. Idempotency at Three Levels

Every run-triggering path MUST be protected by all three independent
idempotency layers:

1. **Webhook dedup** — inbound Jira events deduplicated by
   `X-Atlassian-Webhook-Identifier` (`webhook_events` unique constraint per
   workspace).
2. **Queue dedup** — BullMQ `deduplication: { id: ticket:agent }` on
   enqueue.
3. **Database guard** — partial unique index `runs_one_active` on
   `(ticket_id, agent_id)` WHERE status is active (`queued`, `running`,
   `awaiting_human`).

No layer may be removed or relied upon alone; each guards against failures
the others cannot see (replayed webhooks, queue races, concurrent
enqueuers). New trigger sources (manual, poller, human-resume) MUST pass
through the same three layers.

**Rationale**: Webhooks replay, pollers overlap with webhooks, and queues
race — only defense in depth guarantees at most one active run per
(ticket, agent).

### III. System-Only Jira Writes

Only BRIGADIR writes to Jira. Agents NEVER transition tickets, post
comments, or modify issues themselves — they report exclusively through the
callback tools (`report_progress`, `request_human`, `complete_task`), and
the system performs all Jira actions (transitions, ADF comments, human
tasks) from those reports.

- This rule MUST be embedded in every agent instruction wrapper.
- All Jira writes go through the JiraModule per-issue write queue with
  rate limiting; no module or agent may call the Jira API directly around
  it.
- Callback authentication uses a short-lived per-run JWT scoped to a single
  run with callback-only scopes.

**Rationale**: A single write path makes every board change attributable,
rate-limit-safe, idempotent, and auditable; agents holding Jira write power
would break all four properties at once.

### IV. Run Completion Contract

A run is complete only when a `complete_task` callback with a
schema-valid structured report is received.

- The report MUST validate against the versioned `ReportSchema` (zod /
  JSON Schema, `schema_version` required); `outcome=needs_human` REQUIRES a
  `human_task` object.
- The single legitimate exception is a blocking `request_human`: it moves
  the run to `awaiting_human`, after which the agent process may exit
  without `complete_task`.
- Any other process exit without `complete_task` MUST be recorded as
  `failed` with diagnostics; enforcement (Stop-hook for Claude executors,
  fallback structured-output channels) exists to make this rare, never to
  relax it.
- A repeated `complete` for a finished run MUST be rejected (409) —
  completion is idempotent.

**Rationale**: Pipeline decisions (transitions, chaining the next agent,
creating human tasks) are driven entirely by the report; an unreported run
must fail loudly rather than leave the board and database inconsistent.

### V. Secret Isolation & Output Scrubbing

Secrets never appear in argv and never in the agent process environment.

- Run tokens, API keys, and git credentials live only in the environment of
  the tool process (MCP server) or behind a broker/credential helper — out
  of the agent's reach. Config files reference them via env interpolation
  (e.g. `${BRIGADIR_RUN_TOKEN}`), never inline values.
- Agent environments MUST be sanitized (no `ANTHROPIC_API_KEY` or other
  host secrets leaking in); CLI executors MUST use `--strict-mcp-config`
  and explicit `--settings` so host configuration cannot leak into a run.
- Every outgoing report MUST pass the secret scrubber (regex + entropy)
  before being written to the database or posted to Jira.
- Credentials at rest (Jira tokens, executor secrets) are stored encrypted
  (AES-256-GCM) with expiry tracking and alerting.

**Rationale**: Agents execute untrusted-adjacent model output; keeping
secrets structurally unreachable is the only defense that does not depend
on the model behaving.

### VI. Test-Mandatory Pipeline Logic

Tests are mandatory for all pipeline logic. Any code on the path from
ingest to Jira write — webhook/poller normalization and dedup, the ticket
state machine, agent matching, enqueue/dedup, executor lifecycle and
status mapping, callback validation, report processing, transition
decisions, and human-task flows — MUST ship with automated tests in the
same change.

- Idempotency guarantees (Principle II) MUST each have explicit tests
  (duplicate webhook, duplicate enqueue, concurrent run insert).
- Contract boundaries (`ReportSchema`, callback tool schemas, executor
  `RunContext`/`ExecutorResult`) MUST have contract tests; schema changes
  are forward-compatible and versioned.
- Mock executors are the sanctioned way to test the pipeline without live
  agents; a feature is not done while its pipeline behavior is verifiable
  only by a live run.
- UI and cosmetic changes MAY ship with lighter coverage; pipeline logic
  has no such exemption.

**Rationale**: The pipeline runs autonomously against a production Jira
board; untested transition logic fails silently at 3 a.m., not in code
review.

## Technology Constraints

The stack is fixed; deviations require a constitution amendment:

- **TypeScript strict** — `strict: true` across all packages; no `any`
  escapes at module boundaries. Shared contracts (schemas, JWT claims,
  tool definitions) live in `packages/contracts` as the single typed
  source.
- **NestJS 11** — backend and worker (WorkerHost) framework.
- **BullMQ 5** — queues only, one queue per executor type, global
  concurrency from executor config; Redis holds nothing durable.
- **Postgres 16** — system of record for all orchestration data;
  migrations are versioned and checked in.
- **Vue.js** — dashboard, consuming REST + SSE.
- Executor implementations plug in behind the `AgentExecutor` interface;
  the runtime abstraction is `RunRuntime`. New executors or runtimes MUST
  implement these contracts rather than fork the pipeline.
- **Lazy resource resolution** — anything evaluated inside a `@Module()`
  decorator argument (e.g. `SomeModule.register()` in `imports: [...]`)
  executes at MODULE IMPORT time, before env vars or config set later (test
  `beforeAll`, process managers) exist. Therefore connections, credentials,
  and URLs MUST be resolved inside DI factories at context init
  (`forRootAsync` / `useFactory` / provider factories) — never eagerly at
  module composition, and never with silent fallbacks to localhost defaults.
  Composition-time reads are permitted only for static structure (e.g. queue
  names for `registerQueue`/`@Processor`) and MUST be documented at the call
  site. (Root-caused in iteration 1: an eager Redis connection sent every
  consumer to a host-local redis — see docs/progress.md, "Post-DoD fix".)

## Development Workflow

- Work proceeds in iterations of 0.5–2 days, sized as one PR: plan →
  plan approval → autonomous implementation with tests → checkpoint
  against the iteration's Definition of Done.
- `docs/plan-internal.md` is the active work plan and overrides
  `docs/roadmap.md` / `docs/spec.md` where they conflict; the progress
  journal is kept in `docs/progress.md`.
- Every PR MUST be checked against this constitution; violations either
  block the change or are justified in the plan's Complexity Tracking
  table with the simpler alternative and why it was rejected.
- Scope discipline: features cut from the internal-tool plan (OAuth 3LO,
  sandboxes, multi-tenant, RBAC, behavior compiler) are not reintroduced
  ad hoc — the abstractions that allow them later (`AgentExecutor`,
  `RunRuntime`, wrapper template) are kept intact instead.

## Governance

- This constitution supersedes all other development practices for
  BRIGADIR. Where `docs/architecture.md` or specs conflict with it, the
  constitution wins until amended.
- **Amendments**: proposed as a PR modifying this file, including a Sync
  Impact Report, updates to dependent templates
  (`.specify/templates/*.md`), and migration notes for any in-flight
  specs. Approval by the project owner is required.
- **Versioning**: semantic — MAJOR for removing or redefining a principle
  in a backward-incompatible way; MINOR for adding a principle or
  materially expanding guidance; PATCH for clarifications and wording.
- **Compliance review**: the `/speckit-plan` Constitution Check gate MUST
  pass before design work begins and be re-checked after design;
  `/speckit-analyze` treats constitution conflicts as CRITICAL findings.
  Any deliberate violation MUST appear in the plan's Complexity Tracking
  table.

**Version**: 1.1.0 | **Ratified**: 2026-07-10 | **Last Amended**: 2026-07-11

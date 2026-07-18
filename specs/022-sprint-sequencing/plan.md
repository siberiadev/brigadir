# Implementation Plan: Sprint Sequencing — Guaranteed Execution Order for Blocked-By Chains

**Branch**: `claude/sprint-sequencing-blocked-by-natxlb` (feature directory `022-sprint-sequencing`) | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/022-sprint-sequencing/spec.md`

## Summary

The release mechanism the spec's brief assumed missing **already exists**: `ReconcileService.reEvaluateDependencies` (`libs/ingest/src/reconcile.service.ts`) runs every reconcile pass, batch-fetches fresh issue links for trigger-status tickets without an active/succeeded run, and triggers the now-clear ones — exactly the pull-based re-validation the clarify session settled on (see [research.md](research.md) R1; integration-tested in `test/integration/dependency-gate.spec.ts`). This feature therefore does NOT rebuild the release loop. It adds what is genuinely missing around it:

1. **Deterministic release order** — ingest Jira `priority` (new poll field + two `tickets` columns), sort the release loop by priority then `jira_key`.
2. **Persisted waiting state** — `tickets.blocked_by` / `tickets.blocked_state` diff-cache columns, kept current by the trigger-skip path and the re-eval pass.
3. **Diagnostics** — cycle detection over the waiting set, dead-end classification (resolution set but not done-category), out-of-scope classification (scope-JQL probe), one deduplicated run-less human task per out-of-scope-blocked ticket.
4. **Visibility** — paginated `GET /api/workspaces/:id/waiting` endpoint + a "Waiting" tab on the workspace page.
5. **Fast path (SHOULD, FR-003)** — extract the re-eval into a shared `DependencyReleaseService` (libs/pipeline) so `onWorkerFinished` can release dependents immediately after a successful `status_success` transition instead of waiting a full reconcile interval.

## Technical Context

**Language/Version**: TypeScript strict, Node 22 (existing monorepo settings)

**Primary Dependencies**: NestJS 11, BullMQ 5, drizzle-orm (Postgres 16), Vue 3 + Element Plus + TanStack Query, zod contracts in `packages/contracts`

**Storage**: Postgres 16 (`tickets` gains 4 nullable columns; migration checked into `drizzle/`); Redis stays queues-only

**Testing**: vitest unit + integration (testcontainers Postgres/Redis, mock-jira MSW harness in `test/integration/`); extends `dependency-gate.spec.ts`

**Target Platform**: Linux server (backend + worker containers), dashboard SPA

**Project Type**: web-service monorepo (apps/backend, apps/worker, apps/web, libs/*, packages/*)

**Performance Goals**: release wave ≤ 1 reconcile pass (SC-002); re-eval adds ≤ 2 extra Jira calls per pass, only when the waiting set is non-empty

**Constraints**: HWM/JQL `since` format untouchable (live-incident comment in `scope-jql.ts`); `runs_one_active` and the three dedup layers untouched; finalization guards (`WHERE status='running'`) untouched; schema change requires synchronized `docs/architecture.md` §3 edit (hard-won rule 5)

**Scale/Scope**: internal team tool — waiting set per workspace expected < 50 tickets; sprint chains of 3–10 tickets

## Constitution Check

*GATE: evaluated against constitution v1.2.0 — PASS (pre-design and re-checked post-design). No violations; Complexity Tracking empty.*

- **I. Dual Source of Truth** — PASS. `blocked_by`/`blocked_state`/`priority_*` are explicitly diff-cache columns (like `last_seen_status`): written only from observed Jira data, never authoritative; release decisions are made on freshly fetched issue links, not on the cache. Reconciliation remains the guarantee; the fast path is an optimization layered on the same code path.
- **II. Idempotency at Three Levels** — PASS. Every new start goes through `RunTriggerService.trigger` (queue dedup + `runs_one_active`); the ordering change only sorts the existing loop. No new trigger source bypasses the layers; fast path reuses the same release service.
- **III. System-Only Jira Writes** — PASS. Feature adds zero agent-side writes. The only new Jira traffic is reads (blocker fetch + scope probe). The out-of-scope human task performs no transition and no comment (the ticket legitimately stays in its trigger status).
- **IV. Run Completion Contract** — PASS. Untouched.
- **V. Secret Isolation** — PASS. No new secrets, env read lazily via existing factories.
- **VI. Test-Mandatory Pipeline Logic** — PASS. Ordering, waiting-state persistence, classification, cycle detection, human-task dedup, and the fast path are all pipeline logic → unit + integration tests land in the same iteration (see quickstart.md scenarios; tasks will mirror them).
- **Technology Constraints** — PASS. No `@Module()`-decorator resource init; new service wired through existing DI. `scope-jql.ts` moves file-wholesale to `libs/jira` (no logic edits) to keep the dependency graph acyclic (R6).

## Project Structure

### Documentation (this feature)

```text
specs/022-sprint-sequencing/
├── plan.md              # This file
├── spec.md              # Feature specification (clarified 2026-07-18)
├── design-brief.md      # Verbatim original brief
├── research.md          # Phase 0 — decisions R1..R8
├── data-model.md        # Phase 1 — tickets columns, states, architecture.md §3 sync
├── quickstart.md        # Phase 1 — end-to-end validation scenarios
├── contracts/
│   └── dashboard-waiting.md   # GET /api/workspaces/:id/waiting contract
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
libs/
├── jira/src/
│   └── scope-jql.ts               # MOVED here from libs/ingest (file-wholesale, R6)
├── ingest/src/
│   ├── poller.service.ts          # + priority upsert, + blocked_by persistence on skip-path parity
│   ├── reconcile.service.ts       # step 2 delegates to DependencyReleaseService
│   └── scope-jql.ts               # removed (re-exported from @brigadir/jira during move)
├── pipeline/src/
│   ├── dependency-gate.ts         # unchanged gate; + blockingKeys reuse
│   ├── dependency-release.service.ts  # NEW: re-eval loop + ordering + classification + fast path entry
│   └── pipeline.service.ts        # blocked-skip persists waiting state; onWorkerFinished calls fast path
├── human-tasks/src/
│   └── human-task.service.ts      # + createTicketBlocked (run-less, per-ticket dedup)
└── database/src/schema/tickets.ts # + priority_id, priority_name, blocked_by, blocked_state

packages/contracts/src/
├── jira.types.ts                  # JiraIssue.fields.priority?: { id, name }
└── dashboard (workspaces schema)  # WaitingTicket item + paginated envelope (factory)

apps/backend/src/dashboard/
└── workspaces.controller.ts       # + GET /api/workspaces/:id/waiting (parsePagination, ORDER BY)

apps/web/src/
├── views/WorkspaceWaiting.vue     # NEW child tab: waiting list + state tags
├── router/index.ts                # + waiting child route
├── api/ + composables/            # useWaitingTickets (placeholderData: prev, usePagination)

drizzle/                           # NEW migration: 4 tickets columns
docs/architecture.md               # §3 tickets DDL updated in the same change (rule 5)

test/integration/
├── dependency-gate.spec.ts        # extended: chain E2E, priority wave, fast path
└── sprint-sequencing.spec.ts      # NEW: waiting endpoint, out-of-scope human task, cycle warning
```

**Structure Decision**: existing monorepo layout; no new packages. The only structural move is `scope-jql.ts` → `libs/jira` (R6) so `libs/pipeline` can build scope JQL without importing `libs/ingest` (which already imports pipeline — a cycle otherwise).

## Complexity Tracking

*(empty — no constitution violations to justify)*

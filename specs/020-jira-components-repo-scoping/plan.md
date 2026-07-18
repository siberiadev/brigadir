# Implementation Plan: Per-Ticket Repository Scoping via Jira Components

**Branch**: `claude/jira-components-repo-scoping-fe5fca` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/020-jira-components-repo-scoping/spec.md` (+ settled decisions D1–D5 in [design-brief.md](design-brief.md))

## Summary

Make the ticket's Jira Components field narrow a run's repository set: components that name
workspace repositories are intersected with the agent's configured base set (D1), and only
that subset is cloned/worktree-mounted. When a workspace has opted in (`ticket_scoping`
flag, D2b) and the scope is undeterminable, the run parks fail-closed to the human queue
with one of three case-specific questions (D2), skipping single-repository base sets (D2a).
Technical approach (research R1–R10): carry `components` from `getIssue()` through
`TicketDetail`/`RunContext.ticket`; add a pure `narrowByTicketComponents()` resolver beside
the feature-019 resolvers at the existing pre-clone insertion point in the claude_cli
executor; park via a typed executor error caught by the run processor and delegated to the
existing `HumanTaskService.createFromRequest` (guarded park, Jira transition + comment);
record the narrowing decision as a run-timeline event; extend the wrapper with a
`.repos/<name>` self-clone note for repositories excluded by narrowing (D4). Setup runs
untouched (D5). No DB schema change — the flag is a `workspaces.settings` jsonb key.

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js, pnpm monorepo

**Primary Dependencies**: NestJS 11 (backend + WorkerHost worker), BullMQ 5, Drizzle ORM, zod (contracts in `packages/contracts`), Vue 3 + Element Plus (dashboard)

**Storage**: Postgres 16 (system of record; NO schema change in this feature — jsonb-only additions), Redis (BullMQ queues only)

**Testing**: vitest unit tests colocated with sources; integration via vitest + testcontainers (real Postgres/Redis, shared containers per `test/integration/global-setup.ts`)

**Target Platform**: Linux/macOS server (docker compose stack: postgres, redis, backend, worker)

**Project Type**: Monorepo web service — NestJS apps (`apps/backend`, `apps/worker`), shared libs (`libs/*`), contracts (`packages/contracts`), Vue dashboard (`apps/web`)

**Performance Goals**: Narrowing must not add a Jira round-trip (components ride the existing `getIssue` dispatch fetch); parked runs perform zero clone work (gate evaluates before worktree creation)

**Constraints**: Fail-closed gate is opt-in per workspace, default OFF with byte-identical legacy behavior; no process-outcome write may clobber callback state (park guarded to `status='running'`); lazy resource resolution (flag read at run time, never at module composition); agents never write to Jira (parking drives writes through the system's per-issue queue)

**Scale/Scope**: Internal team tool; a handful of workspaces, ≤ ~10 repositories per workspace; touches ~6 libs/apps, ≈ 12 source files + tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | How this feature complies |
|---|---|---|---|
| I | Dual Source of Truth | ✅ PASS | Components are read from Jira at dispatch (`fetchTicketDetail`) and never persisted as authoritative state; the narrowing decision lands in `run_events` (run history — Postgres's domain). The flag lives in `workspaces.settings` (config, not ticket state). No third source of truth introduced. |
| II | Idempotency at Three Levels | ✅ PASS | No new trigger path. The park→resolve→successor-run loop reuses `ResumeService`, whose insert already passes the `runs_one_active` guard (parked run is `superseded` in the same transaction). Webhook/queue dedup untouched. |
| III | System-Only Jira Writes | ✅ PASS | Parking's blocked-status transition + question comment go through `HumanTaskService` → per-issue write queue. The executor itself never touches Jira (it throws; the processor delegates). Agents gain no write capability. |
| IV | Run Completion Contract | ✅ PASS | The park uses the one legitimate exception (blocking human task → `awaiting_human`, process may exit without `complete_task` — here it never starts). Components-unreadable (R5) → `failed` with diagnostics, not a silent fallback. No new completion channel. |
| V | Secret Isolation & Output Scrubbing | ✅ PASS | Human-task title/details are system-composed from fixed templates + ticket key/component names/repo names only (feature-010 precedent); no secrets can appear. Wrapper lists repo names + git URLs (not credentials). No new secret surface. |
| VI | Test-Mandatory Pipeline Logic | ✅ PASS (obligation) | Scope resolution, the gate, parking, and the resume round trip are pipeline logic → unit decision-table tests for `narrowByTicketComponents` + integration tests (testcontainers) incl. park→resume→rescope ship in the same iteration. See quickstart.md. |
| — | Tech constraints (lazy resolution) | ✅ PASS | The flag and components are read per run inside `resolveClaudeCliConfig` / `fetchTicketDetail` — runtime reads, nothing at `@Module()` composition. |
| — | CLAUDE.md rule 5 (schema frozen without doc update) | ✅ PASS | No DDL. jsonb key + additive zod fields only. |
| — | CLAUDE.md rule 7 (no clobbering callback state) | ✅ PASS | Parking reuses the guarded `parkRun` (`WHERE status='running'`); the processor's park path returns without finalizing, and the guarded finalizes no-op on `awaiting_human`. |

**Initial gate**: PASS (no violations, Complexity Tracking empty).
**Post-design re-check (after Phase 1)**: PASS — the design introduced no new persistence, no new Jira write path, no new completion channel; the only cross-module addition is providing the existing `HumanTaskService` in the worker (direct provider; see R4 as-built note).

## Project Structure

### Documentation (this feature)

```text
specs/020-jira-components-repo-scoping/
├── spec.md              # Feature specification
├── design-brief.md      # Verbatim input brief (settled D1–D5)
├── plan.md              # This file
├── research.md          # Phase 0 — R1–R10 decisions + verified reference index
├── data-model.md        # Phase 1 — jsonb/type/contract additions (no DDL)
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── scope-resolution.md          # Pure resolver decision table (D1/D2/D2a/D2b/D3)
│   ├── jira-getissue-components.md  # Extended getIssue + TicketDetail + RunContext.ticket
│   └── workspace-settings-flag.md   # ticket_scoping flag: settings jsonb + API + UI
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── jira.types.ts                 # WorkspaceSettingsSchema + ticket_scoping (R3)
└── dashboard.schema.ts           # WorkspaceSettingsRequestSchema / WorkspaceResponseSchema additive field

libs/jira/src/
├── jira-client.interface.ts      # getIssue return + components: string[]
├── basic-auth-jira.client.ts     # fields=summary,description,components (R2)
└── lazy-jira.client.ts           # delegate signature

libs/executors/src/
├── agent-executor.interface.ts   # RunContext.ticket + components: string[] | null (R1)
└── claude-cli/
    ├── scope-ticket.ts           # NEW — narrowByTicketComponents() + RepositoryScopeUndeterminableError (R10)
    ├── scope-ticket.spec.ts      # NEW — decision-table unit tests
    ├── claude-cli.executor.ts    # gate call at the normal-run branch (:611); run-event record (R6)
    ├── wrapper.ts                # excluded-repos .repos/<name> note for narrowed runs (R8)
    └── wrapper.spec.ts           # wrapper back-compat + narrowed-run snapshot

apps/worker/src/
├── ticket-detail.ts              # TicketDetail.components: string[] | null (R1/R5)
├── claude-cli-run.processor.ts   # buildContext ticket.components; typed-error catch → HumanTaskService (R4)
├── run.processor.ts              # buildContext ticket.components (type only, mock path — R9)
└── app.module.ts                 # + HumanTasksModule import (R4)

apps/backend/src/workspaces/      # settings controller/service accept + serialize ticket_scoping
apps/web/src/                     # workspace Settings tab: ticket-scoping toggle (feature-006 'enabled' pattern)

test/integration/
├── claude-cli-scoping.spec.ts    # NEW — narrowed clone set; flag-off matrix; three park cases
└── (park→resume→rescope round trip — here or in human-resume spec, following claude-cli-repository.spec.ts)
```

**Structure Decision**: No new packages or modules — the feature threads one new field
through the existing Jira-client → processor → executor path and adds one new pure module
(`scope-ticket.ts`) beside the feature-019 resolvers it extends. The only wiring change is
`HumanTasksModule` into the worker's imports (its providers resolve against the worker's
existing global DRIZZLE/JIRA_CLIENT/queue providers).

## Design outline (how the pieces connect)

Dispatch-time flow for a normal claude_cli run (setup runs bypass at step 4 — D5):

1. `ClaudeCliRunProcessor` marks the run running, then `fetchTicketDetail()` fetches
   description + **components** via `getIssue` (components `null` on fetch failure — R5).
2. `buildContext()` puts `components` on `RunContext.ticket`.
3. `executor.run(ctx)` → `resolveClaudeCliConfig()` resolves the base set exactly as today
   (`resolveRepositoryNames` → `resolveRepositories`, fail-loud on config-derived names).
4. NEW: `narrowByTicketComponents({ baseRepos, components, workspaceRepoNames, scopingEnabled })`
   — flag OFF ⇒ full base set (byte-identical legacy path); base set ≤ 1 ⇒ as-is (D2a);
   otherwise intersect (D1, D3 silent filtering, case-insensitive trimmed match — R7).
5. Outcome `resolved` ⇒ run-event `repo-scoping` recorded, worktrees built from the
   narrowed list, wrapper lists excluded repos as on-demand `.repos/<name>` clones (D4).
6. Outcome `undeterminable` ⇒ throw `RepositoryScopeUndeterminableError(case, display)` —
   before any clone. Processor catches the type, calls
   `HumanTaskService.createFromRequest(runId, { kind:'blocker', blocking:true, … })`
   (guarded park → `awaiting_human`, Jira blocked transition + case-specific question
   comment), records the run event, and returns without finalizing.
7. Outcome `components_unreadable` (gate active, Jira fetch failed) ⇒ plain error → run
   `failed` with diagnostics (R5).
8. Human sets Components → resolves the task → existing `ResumeService` supersedes the
   parked run and inserts a fresh `queued` run → steps 1–5 re-run with the new components
   (spec FR-011; no new wiring).

## Complexity Tracking

> No constitution violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

# Implementation Plan: Workspace Setup by the Orchestrator ("Generate agents") + Read-Only Jira Tools

**Branch**: `011-workspace-setup` (git: `claude/brigadir-workspace-setup-8dq1ru`) | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-workspace-setup/spec.md`

## Summary

Today assembling a workspace means hand-writing every worker agent. This feature makes the
seeded **"brigadir" orchestrator** (feature 010) do it: a new workspace is created **paused**
(`settings.enabled=false`); a **Generate agents** action (offered while the workspace has no
worker agents) starts a **ticketless setup run** (`trigger source 'workspace-setup'`, no repo,
cheap orchestrator profile). The orchestrator studies the Jira project through three new
**read-only Jira callback tools** — available to ALL callback-wired runs, so workers gain
mid-run access to ticket comments/descriptions too — plus a compact project-digest handoff,
and returns a one-shot **`team` report outcome**: the proposed agents (name, description,
instruction, trigger/status mapping, executor profile). The completion path validates the
proposal atomically (statuses on the live board, unique names, enabled executor profiles);
invalid proposals bounce back to the agent as a `422` repair loop; a valid one is applied in
ONE transaction — agents created **enabled** + a non-blocking **review human task** — while the
workspace stays paused. The human reviews the team in the existing agents UI, resolves the
review task, and flips the single existing start switch.

Technical approach: relax the ticket-required invariant (nullable `ticket_id` on
`runs`/`human_tasks` + `runs_one_active_setup` partial index), extend the report/trigger
contracts (`team` outcome, `workspace-setup` source), extend the callback MCP server and
`JiraClient` with reads, add the setup branch to handoff assembly and pipeline completion,
add the generate endpoint, and teach ~6 read sites + 4 UI components about `ticket: null`.
All new pipeline logic ships with unit + integration tests (mock executor scenarios `team` /
`team_invalid`) against real Postgres/Redis (Constitution VI).

## Technical Context

**Language/Version**: TypeScript 5.7 (strict), Node ≥ 22, pnpm 9 workspace monorepo

**Primary Dependencies**: NestJS 11 (backend + worker WorkerHost), BullMQ 5, drizzle-orm
(Postgres), zod (contracts), `@modelcontextprotocol/sdk` (callback MCP server), Vue.js 3 +
TanStack Query + Element Plus (dashboard)

**Storage**: Postgres 16 (system of record; migration 0005: nullable ticket refs + setup
uniqueness index); Redis (BullMQ queues only)

**Testing**: vitest — unit + contract projects, `test:integration` (testcontainers
Postgres/Redis, shared per run, per-suite `BULLMQ_PREFIX`), mock executor + mock Jira layer

**Target Platform**: Linux server (docker compose: postgres, redis, backend, worker) + browser dashboard

**Project Type**: Web application — NestJS backend/worker (`apps/`, `libs/`), shared typed
contracts (`packages/contracts`), stdio MCP server (`packages/mcp-server`), Vue SPA (`apps/web`)

**Performance Goals**: Not latency-bound. Read tools ride the existing per-workspace Jira rate
limiter (5 rps default) — no separate quota; handoff/digest assembly best-effort and
size-bounded, never stalls run creation; setup run capped by the orchestrator profile's
`max_turns`/timeout.

**Constraints**: No Jira writes anywhere on the setup path (nothing to write — Principle III
trivially holds); read tools structurally scoped (server-composed JQL, project-key check) and
credential-free for the agent (Principle V); completion contract untouched — business-invalid
proposals are `422`-rejected, never post-finalize demoted (Principle IV); ticketed pipeline
behavior byte-for-byte unchanged (left joins serialize identically when a ticket exists).

**Scale/Scope**: Internal tool, single-digit workspaces. Touches: contracts (report, trigger,
callback-tools, run-token, runs/human-queue responses), migration 0005, callback lib (guard
untouched, +3 endpoints, accept-path validator/applier), `JiraClient` (+2 reads), MCP server
(+3 tools), handoff (+1 branch), pipeline completion (+setup case), resume flow (+setup rule),
run trigger (ticket-optional), 2 worker processors, wrapper, generate endpoint, ~4 web views +
composables. Proposal cap 20 agents; comments cap 20×1500 chars; search cap 50.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — PASS both times.*

| Principle | Assessment | Compliance |
|-----------|-----------|------------|
| **I. Dual Source of Truth** | Setup runs/review tasks live in Postgres run history; no ticket ⇒ no Jira status to mirror, and the feature adds no third source. Read tools serve LIVE Jira data (never cached as truth); the digest uses the existing statuses cache for prompt context only. Paused workspaces stay out of reconcile via the existing `settings.enabled` selector. | ✅ PASS |
| **II. Idempotency at Three Levels** | Generate path: endpoint precondition check (stands in for webhook dedup, like test-run/retry) + BullMQ `jobId=runId` + NEW `runs_one_active_setup` partial unique index (D3) — `runs_one_active` cannot cover NULL tickets, so the third layer is replaced, not removed. Proposal apply is replay-safe via the 010 completion-marker pattern (D10) and transactional (no partial teams). | ✅ PASS |
| **III. System-Only Jira Writes** | Read tools expose ZERO write operations and go through the backend's `JiraClientFactory` (rate-limited); agents still never hold Jira credentials. The setup path performs no Jira writes at all. Agents are created by the system from a validated report — the 010 "agent reports, system acts" pattern. | ✅ PASS |
| **IV. Run Completion Contract** | `team` is a schema'd `ReportSchema` outcome (`team ⇒ payload` mirror rule). Business-invalid proposals are rejected at accept time (`422` repair loop) so the run is complete only when a valid report is ACCEPTED — no post-finalize demotion, no new rescue path, repeated complete still 409 (D9). Fail-closed path unchanged for runs that never land a valid proposal. | ✅ PASS |
| **V. Secret Isolation & Output Scrubbing** | Read endpoints keep Jira credentials in the backend; the MCP server stays a zero-DB thin HTTP client on the existing 0600-config delivery. `team.agents[].description/instruction` pass the scrubber before persistence (identifiers exempt, same as `target_agent`). Setup runs use the repo-less orchestrator profile — no git creds in reach. | ✅ PASS |
| **VI. Test-Mandatory Pipeline Logic** | Every new path is pipeline logic and ships with tests in the same change: generate preconditions + race (SC-003), accept-path validation/apply/replay (SC-004/007), paused-workspace gate (SC-002), read tools incl. scope rejection (SC-005), resume-of-parked-setup, ticketless serialization. Mock scenarios `team`/`team_invalid` make the loop drivable without live agents (SC-008). | ✅ PASS |
| **Tech constraints** | Migration versioned + checked in with SQL review vs §3 (rule 5). No eager resource resolution added (new endpoints/services use existing DI factories). Contracts extended in `packages/contracts` only. No executor/runtime fork — setup runs are ordinary runs on the existing orchestrator profile. Scope rule honored: no re-generation, no orchestrator-written workspace settings (v1 cuts stay cut). | ✅ PASS |

**Result**: PASS — no violations. Complexity Tracking table intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/011-workspace-setup/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1..D17
├── data-model.md        # Phase 1 — schema deltas, contract entities, lifecycle
├── quickstart.md        # Phase 1 — validation scenarios A–E
├── contracts/           # Phase 1
│   ├── report-schema.md         # `team` outcome + accept-path semantics
│   ├── jira-read-tools.md       # 3 MCP tools + callback endpoints
│   ├── generate-agents-api.md   # generate endpoint + workspace/runs/queue deltas
│   ├── handoff-setup.md         # setup handoff block (digest + protocol + Q&A)
│   └── nullable-ticket.md       # cross-cutting ticketless delta inventory
├── checklists/          # pre-existing (requirements — all pass)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

Existing NestJS + Vue monorepo, extended in place (→ = extend, + = new):

```text
packages/contracts/src/
├── report.schema.ts             → outcome 'team' + TeamAgentSchema + superRefine (D9)
├── trigger-event.schema.ts      → source 'workspace-setup'; MOCK_SCENARIOS += team, team_invalid
├── callback-tools.schema.ts     → GetProjectOverview/SearchTickets/GetTicket input schemas (D5)
├── run-token.ts                 → tkt claim optional (D4)
├── runs.schema.ts               → ticket nullable; RunListQuery += source (D16)
└── human-queue.schema.ts        → ticket nullable (D16)

libs/database/src/schema/
├── runs.ts                      → ticketId nullable + runs_one_active_setup index (D2/D3)
└── human-tasks.ts               → ticketId nullable

drizzle/
├── 0005_workspace_setup.sql     + DROP NOT NULL ×2 + partial unique index
└── REVIEW-0005_workspace_setup.md + SQL review vs architecture.md §3

libs/jira/src/
├── jira-client.interface.ts     → getIssueDetail, searchIssues (D7)
└── basic-auth-jira.client.ts    → impls (+ issue-type extraction from project statuses)

libs/callback/src/
├── callback.controller.ts       → +3 read endpoints (overview/search/tickets/:key) (D5/D6)
├── jira-read.service.ts         + scope-checked, size-bounded read mappers (D6/D8)
└── callback.service.ts          → scrubReport += team fields (D10)

libs/runs/src/
├── run-trigger.service.ts       → ticketId optional; workspace-setup skips BullMQ dedup (D1)
└── runs.service.ts              → finalizeWithReport: 'team' accept-path hook (validate+apply tx) (D9/D10)

libs/pipeline/src/
├── setup-apply.service.ts       + proposal validator (lintAgent reuse) + atomic applier + review task (D9/D10)
├── pipeline.service.ts          → orchestrator branch: workspace-setup case (marker only; failure task wording)
└── handoff.ts                   → 'workspace-setup' branch: digest + protocol + resume Q&A (D13)

libs/human-tasks/src/
├── human-task.service.ts        → transitionAndComment tolerates null ticket (skip Jira)
└── resume.service.ts            → parked workspace-setup ⇒ new setup run; reject target on ticketless (D12)

libs/executors/src/
├── agent-executor.interface.ts  → RunContext.ticket nullable (D4)
├── claude-cli/wrapper.ts        → ticketless header branch; read-tools paragraph (D4/D5)
└── mock.executor.ts             → 'team' / 'team_invalid' scenarios (D15)

apps/worker/src/
├── run.processor.ts             → leftJoin tickets; null-ticket context (D2)
└── claude-cli-run.processor.ts  → leftJoin tickets; skip ticket-detail/feature-context; tkt? (D2/D4)

apps/backend/src/dashboard/
├── workspaces.controller.ts     → create paused; POST :id/generate-agents (D11/D14)
├── runs.controller.ts           → left joins; ticket nullable; source filter (D16)
└── human-tasks.controller.ts    → left join; ticket nullable (D16)

libs/app-config/src/config-seeder.ts → new seeded workspaces paused (D14)

packages/mcp-server/src/
├── main.ts                      → TOOL_DEFS + dispatch += 3 read tools (both hardcoded spots!)
└── tools.ts                     → read-tool handlers (GET support alongside postWithRetry)

apps/web/src/
├── views/AgentsList.vue         → Generate agents button + state (D11)
├── views/Runs.vue               → null-ticket label; (source filter internal) (D16)
├── views/RunCard.vue            → null-ticket header (D16)
├── components/HumanQueue/HumanTaskRow.vue / HumanTaskDrawer.vue → null-ticket label (D16)
├── views/HumanQueue.vue         → hide ResumeAgentPicker on ticketless tasks (D12)
├── api/… + composables/useRuns.ts / useAgents.ts → source filter, generate mutation
└── views/WorkspaceWizard…       → post-create "starts paused" hint (D14)

docs/architecture.md             → §3 (nullable + index), §5 (read tools), §6 (team outcome) (D17)
docs/plan-internal.md            → feature row (slotting vs iterations 12–13 at merge) (D17)

Tests: contract specs (report/trigger/callback-tools/runs/human-queue schemas);
unit (handoff setup branch, wrapper branch, jira-read mappers, setup validator);
integration (workspace-setup loop, generate race, invalid proposal, replay, read tools + scope,
resume-of-parked-setup, ticketless lists/card, paused-workspace reconcile skip);
web (generate button states, null-ticket rendering, picker hidden).
```

**Structure Decision**: extend in place; setup runs are ordinary runs (nullable ticket, existing
orchestrator agent/profile/queue/gate) rather than a parallel "setup pipeline" — the same
keep-the-abstractions-intact choice 010 made for triage. The only new service seams are
`SetupApplyService` (validator/applier, because agent creation logic is currently inlined in
`AgentsController` and must become reusable without HTTP) and `jira-read.service.ts`
(scoping/truncation policy in one place).

## Complexity Tracking

> No constitution violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

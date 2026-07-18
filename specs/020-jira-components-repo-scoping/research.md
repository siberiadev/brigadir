# Research: Per-Ticket Repository Scoping via Jira Components

**Feature**: 020 | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md) | **Brief**: [design-brief.md](design-brief.md)

Decisions D1–D5 arrived settled in the brief and are not re-derived here. This document
resolves the unknowns the brief flagged plus those that surfaced during tree verification.
All file/line references verified against the current branch.

## R1 — Ticket context carrier: `RunContext`, produced by `buildContext()` in the run processors

**Decision**: Extend `RunContext.ticket` (`libs/executors/src/agent-executor.interface.ts:23`)
with `components: string[] | null`. The producer the brief could not locate is
`ClaudeCliRunProcessor.buildContext()` (`apps/worker/src/claude-cli-run.processor.ts:384`),
which assembles `ticket` from the runs row (`ticketKey`, `ticketSummary`) plus a
`TicketDetail` fetched at dispatch by `fetchTicketDetail()` (`apps/worker/src/ticket-detail.ts`).
`TicketDetail` gains `components: string[] | null` alongside `description`/`url`.

**Rationale**: The brief's grep for `ExecutionContext` failed because the interface is named
`RunContext`. `fetchTicketDetail` is already the established "read the ticket body lazily at
dispatch" seam shared by both run processors — components are the same class of data
(Jira-only, never cached by the poller), so they ride the same fetch. `null` (fetch failed)
is distinguished from `[]` (ticket genuinely has no components) — see R5.

**Alternatives considered**: Having the executor fetch components itself — rejected: the
executor deliberately knows nothing about Jira (interface header comment); the processor
already owns the Jira read. Caching components in the tickets table — rejected: violates
Principle I (Jira is the sole source of truth for ticket data; poller caches status/summary
only) and adds staleness the resume loop would then have to bust.

## R2 — Jira client: extend `getIssue()` to request `components`

**Decision**: `getIssue()` (`libs/jira/src/basic-auth-jira.client.ts:157`) requests
`fields=summary,description,components` and returns `components: string[]` (mapped from
Jira's `[{ name }]`; missing field ⇒ `[]`). Propagate through
`libs/jira/src/jira-client.interface.ts:34` and `libs/jira/src/lazy-jira.client.ts:69`, and
the integration-test double `test/integration/mock-jira.ts`.

**Rationale**: `getIssue` is exactly the call that feeds the run context (via
`fetchTicketDetail`). `getIssueDetail` (fields incl. `labels` but not `components`) feeds
callback read-tools and is left unchanged — no consumer needs components there, and widening
it would grow the payload for every `get_ticket` tool call.

**Alternatives considered**: A separate `getIssueComponents()` call — rejected: one extra
HTTP round-trip per dispatch for a field the existing call can carry for free.

## R3 — The D2b flag: `WorkspaceSettings.ticket_scoping` (jsonb, no DDL)

**Decision**: Add optional `ticket_scoping: z.boolean()` to `WorkspaceSettingsSchema`
(`packages/contracts/src/jira.types.ts:112`). Absent ⇒ OFF. Surface it additively in the
dashboard contract: `WorkspaceSettingsRequestSchema` (PUT `/api/workspaces/:id/settings`)
and `WorkspaceResponseSchema` (`packages/contracts/src/dashboard.schema.ts`), plus a toggle
on the workspace Settings tab in `apps/web` (same pattern as the feature-006 `enabled`
pause flag, which is the direct precedent: jsonb value only, absent-means-default,
additive response field).

**Rationale**: The spec's no-schema-change constraint holds — `workspaces.settings` is an
established jsonb home for exactly this kind of per-workspace behavioral flag (`enabled`,
`rework_max` precedents), with typed accessors in `libs/database/src/workspace-settings.ts`.
The executor already reads this settings blob during repository resolution
(`resolveRepositories`, `claude-cli.executor.ts:703`), so the flag is readable at the
decision point with no new query. Read at run time inside the executor — never at module
composition (constitution "Lazy resource resolution").

**Alternatives considered**: A dedicated column — rejected: requires DDL + architecture §3
update for a boolean the jsonb blob handles idiomatically. Global env flag — rejected by
D2b itself (per-workspace rollout is the point).

## R4 — Parking mechanism: typed executor error, caught by the processor, delegated to `HumanTaskService`

**Decision**: The scope gate runs inside `resolveClaudeCliConfig()` (normal-run branch,
`claude-cli.executor.ts:611`) — before any clone/worktree work. On an undeterminable scope
it throws a typed `RepositoryScopeUndeterminableError` carrying the D2 case
(`no_components` | `no_repo_components` | `outside_agent_scope`) and the safe display
inputs (ticket key, component names, repository names, agent scope).
`ClaudeCliRunProcessor` catches this error type specifically — BEFORE the generic
`catch → exitStatus:'crashed'` mapping (`claude-cli-run.processor.ts:188`) — and calls
`HumanTaskService.createFromRequest(runId, { kind: 'blocker', blocking: true, title, details })`,
then returns without finalizing the run. **As built**: the worker registers
`HumanTaskService` as a DIRECT provider in `app.module.ts` instead of importing
`HumanTasksModule` — the module also carries `ResolveController` and the fail-fast
dashboard-token provider, and the compose worker has no `BRIGADIR_DASHBOARD_TOKEN` in its
environment (importing the module would crash the worker at boot). The service's own deps
(DRIZZLE, `JiraClientFactory`) are globally provided in the worker already.

**Rationale**: Repository resolution lives in the executor (behavior precedence +
`pickWorkspaceRepositories`), but the executor "knows nothing about Jira" by contract —
parking (run status + Jira blocked transition + question comment) belongs to
`HumanTaskService`, which already implements the guarded park (`WHERE status='running'`,
`parkRun()` at `human-task.service.ts:114`), the one-open-task dedup, and the per-issue
Jira write path. The run IS `running` at this point (marked before dispatch), satisfying
the guard; if a race parks it elsewhere first, `createFromRequest` logs and does not
clobber (CLAUDE.md rule 7 honored by construction). The throw happens before spawn and
before worktree creation, so a parked run performs zero clone work (FR-008).

**Kind choice**: `blocker` (`HUMAN_TASK_KINDS`) — the run cannot proceed; `question` is the
agent-asked flavor, `review` is for artifacts. System-composed precedent: feature-010
non-blocking tasks (triage-limit, orchestrator failure) compose title/details from safe
fields without invoking the scrubber; the same discipline applies — text is built ONLY from
ticket key, component names, repository names, and the fixed per-case template (FR-009).

**Alternatives considered**: Injecting `HumanTaskService` into the executor — rejected:
breaks the executor's no-Jira/no-pipeline layering and drags backend modules into
`ExecutorsModule`. Resolving scope in the processor instead — rejected: duplicates the
behavior-precedence + settings-fallback logic that already lives (tested) in the executor.
A new `ExitStatus` value — rejected: parking is not an exit; the process never started,
and `awaiting_human` is already the modeled state for a blocked run.

## R5 — Components unreadable (Jira fetch failure) with scoping ON: fail the run, do not park, do not fail open

**Decision**: `fetchTicketDetail` keeps its non-fatal contract but returns
`components: null` on failure (description already degrades to `''`). When the gate is
active (flag ON, ticket present, base set ≥ 2) and `components === null`, the executor
throws a plain error → the run fails with diagnostics via the existing
`crashed` mapping. When the gate is inactive, `null` behaves like "scoping not applied"
(today's behavior).

**Rationale**: All three alternatives were weighed. Fail-open (proceed with the full base
set) violates D2's core rule the moment it matters. Parking as case 1 would post a wrong
question ("set Components" — they may be set but unreadable) and would itself require a
Jira write during a Jira outage. Failing the run is the honest fail-closed outcome: no
wrong clone, no misdirected human task, visible + retryable through the normal failed-run
path, and consistent with Principle IV (failed with diagnostics).

## R6 — Observability: run-timeline event at the resolution point

**Decision**: At scope resolution the executor inserts one `run_events` row
(`type: 'log'`, payload `{ source: 'repo-scoping', message, components, matched, ignored,
effective, gate }`), following the existing `setup-profile-fallback` precedent
(`claude-cli.executor.ts:680`). `gate` is `'off' | 'skipped_single_repo' | 'passed' |
'parked:<case>' | 'failed:components_unreadable'`. When the gate parks, the human task's
question text itself names the case (FR-007), so queue + timeline together satisfy FR-015.

**Rationale**: The run timeline is the operator's existing per-run surface; a structured
log event needs no schema change (`type` is free text, payload jsonb) and no UI work.
Extending the Jira report comment (`adf-composer.ts`) was considered and dropped from
scope: the comment renders the agent's report, which post-dates scoping and would duplicate
the timeline; revisit only if operators ask for it.

## R7 — Matching rule

**Decision**: Per spec FR-016 — exact comparison of trimmed names, case-insensitive
(`name.trim().toLowerCase()` on both sides), no fuzzy/partial matching. Duplicates
collapse; result preserves workspace declaration order (feature 019 convention).

## R8 — D4 escape hatch: wrapper instruction, mechanics already exist

**Decision**: The self-clone mechanism is purely instructional — the setup protocol's
`.repos/<name>` clones are ordinary `git clone` calls by the agent (see
`DEFAULT_WORKSPACE_SETUP_INSTRUCTION` in `packages/contracts/src/orchestrator-defaults.ts`);
no credential or tooling machinery is setup-specific. For a narrowed normal run, the
wrapper (`libs/executors/src/claude-cli/wrapper.ts`) additionally lists the workspace
repositories that were EXCLUDED by narrowing (name + git URL) with one line: they may be
cloned into `.repos/<name>` on demand if the task turns out to need them. Non-narrowed
runs render exactly today's wrapper (back-compat).

**Rationale**: Reuses the proven setup-protocol idiom verbatim; git URLs are not secrets
(Principle V concerns tokens, which travel via the credential path, not the URL list).

## R9 — Scope of executors: `claude_cli` only

**Decision**: The gate and narrowing apply only to the `claude_cli` executor. The mock
executor path (`run.processor.ts`) mounts no repositories — there is nothing to scope; its
`RunContext.ticket` gains the `components` field type-wise but no behavior changes.
Pipeline-level integration coverage that needs a parked run uses the claude-cli harness
(`test/integration/claude-cli-harness.ts`), as feature 019 did.

## R10 — Resolver shape: new pure function beside the feature-019 resolvers

**Decision**: New pure, dependency-free function in
`libs/executors/src/claude-cli/scope-ticket.ts`:

```
narrowByTicketComponents(input: {
  baseRepos: WorkspaceRepositoryLike[];   // already resolved via existing precedence
  components: string[] | null;            // null = unreadable (R5)
  workspaceRepoNames: string[];           // all workspace repo names, for D2-case classification
  scopingEnabled: boolean;                // R3 flag
}): 
  | { kind: 'resolved'; repos: ...[]; decision: NarrowingDecision }
  | { kind: 'undeterminable'; case: 'no_components' | 'no_repo_components' | 'outside_agent_scope'; decision: ... }
  | { kind: 'components_unreadable' }
```

It applies, in order: flag OFF → resolved with full base set, decision `gate:'off'` (D2b);
base set length ≤ 1 → resolved as-is, `gate:'skipped_single_repo'` (D2a); `components === null`
→ `components_unreadable` (R5); no components → case 1; components ∩ workspace repos = ∅ →
case 2; that ∩ base set = ∅ → case 3 (D1/D3 ordering distinguishes cases 2 vs 3); else
resolved with the intersection. Ticket-derived names never touch
`pickWorkspaceRepositories`' fail-loud branch (D3): the existing config-derived resolution
runs first, unchanged; narrowing filters its OUTPUT.

**Rationale**: Mirrors how feature 019 built `resolveRepositoryNames`/`pickWorkspaceRepositories`
(pure + directly unit-tested in `pick-repository.spec.ts`); keeps the D2-case decision
table exhaustively testable without DB or Jira.

## Verified reference index

| Concern | Location |
|---|---|
| Base-set precedence resolver | `libs/executors/src/claude-cli/claude-cli.executor.ts:54` (`resolveRepositoryNames`) |
| Fail-loud config-name picker (D3 contrast) | `claude-cli.executor.ts:79` (`pickWorkspaceRepositories`, throws at :88) |
| Normal-run call site (insertion point) | `claude-cli.executor.ts:611` |
| Setup-run one-element slice (D5, untouched) | `claude-cli.executor.ts:598-606` |
| Workspace repo source of truth | `claude-cli.executor.ts:703` (`resolveRepositories`) |
| `RunContext.ticket` | `libs/executors/src/agent-executor.interface.ts:23` |
| Ticket producer | `apps/worker/src/claude-cli-run.processor.ts:384` (`buildContext`), `apps/worker/src/ticket-detail.ts` |
| `getIssue` (fields today: summary,description) | `libs/jira/src/basic-auth-jira.client.ts:157`, interface `:34`, lazy `:69` |
| Park + guard + dedup + Jira transition/comment | `libs/human-tasks/src/human-task.service.ts:62` (`createFromRequest`), guard `:114` |
| Resume loop (supersede + fresh queued run) | `libs/human-tasks/src/resume.service.ts:224-246` |
| Worker module (gains `HumanTasksModule`) | `apps/worker/src/app.module.ts` |
| Workspace settings schema + accessors | `packages/contracts/src/jira.types.ts:112`, `libs/database/src/workspace-settings.ts` |
| Settings API + response schemas | `packages/contracts/src/dashboard.schema.ts:74-117` |
| Run-event precedent | `claude-cli.executor.ts:680` (`setup-profile-fallback`) |
| Existing resolver unit tests | `libs/executors/src/claude-cli/pick-repository.spec.ts` |
| Integration model to follow | `test/integration/claude-cli-repository.spec.ts`, harness `claude-cli-harness.ts`, `mock-jira.ts` |

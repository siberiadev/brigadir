# Contract: Workspace-setup handoff section

New branch in `buildHandoffSection` (`libs/pipeline/src/handoff.ts:21`) for
`trigger_event.source === 'workspace-setup'`. Same invariants as every 010 branch:
ephemeral (never persisted), best-effort (any throw → `''`), size-bounded, prepended to the
orchestrator's stored instruction without modifying it (FR-012).

## Block layout

```
## Workspace setup

You are preparing the agent team for workspace "<name>" (Jira project <KEY>, <kanban|scrum> board).
No worker agents exist yet. Study the project and propose the team.

### Project digest
- Board: <type>; project key: <KEY>
- Repositories: <name (default)>, …                  ← workspace.settings.repositories
- Executor profiles available: <name — type/model>, …← executors WHERE enabled
*(Implementation refinement: workflow statuses are deliberately NOT in the
digest — the protocol directs the agent to `get_project_overview` for the
exact names, keeping handoff assembly strictly DB-only and never blocking
on Jira.)*

### How to study the project
You have read-only Jira tools: get_project_overview, search_tickets, get_ticket
(descriptions, comments, links). Use them before proposing. If the project is empty or
ambiguous, ask via request_human instead of guessing.

### How to deliver the team
Return ONE complete_task report with outcome "team": for each agent — name, description
(one roster line), instruction (self-contained role prompt), trigger_status (status that
starts it), status_running (optional), status_success, status_failure, executor (one of the
profile names above). Rules: names must be unique (never "brigadir"); every status must be
one of the workflow statuses above; triggers must not collide between two agents; agents are
created active but the workspace stays paused until a human reviews and starts it.
If validation fails you will receive the errors — fix the proposal and submit again.
```

When resumed from a parked question (`human_task_id` + `resolution` present), append the
existing Q&A block (`questionAnswerLines`, `handoff.ts:259`):

```
### Earlier question and the operator's answer
Q: <task title / details>
A: <resolution>
```

## Size budgets

Reuses the 010 constants where applicable (`SUMMARY_BUDGET`-style): statuses/repositories/
profiles lists rendered in full (small by construction); digest hard cap ~2000 chars with
`trunc()`; protocol lines are static text. Issue types and sprint content are deliberately
NOT in the digest — the read tools carry deep reads (D13), keeping prompt assembly
non-blocking on Jira.

## Sources (read-only, own system data + statuses cache)

`workspaces` row, `workspace.settings`, `agents` (orchestrator name check), `executors`
(enabled profiles), `StatusesService` (board statuses; degrade to omit on failure),
`human_tasks` (resume Q&A). No live Jira calls beyond the statuses cache refresh —
handoff assembly must never fail or stall a run (FR-013 of 010, inherited).

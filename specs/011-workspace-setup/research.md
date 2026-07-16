# Phase 0 Research: Workspace Setup by the Orchestrator + Read-Only Jira Tools

Decisions D1–D17, grounded in the live code (paths verified 2026-07-16 on main @ 9c60684).
Format: Decision / Rationale / Alternatives considered.

---

## D1 — Trigger source `workspace-setup`; BullMQ dedup skipped, DB guard is the authority

**Decision**: Add `'workspace-setup'` to `TRIGGER_SOURCES` (`packages/contracts/src/trigger-event.schema.ts:40-48`). Setup runs skip BullMQ `deduplication` the same way `CONTINUATION_SOURCES` do (`libs/runs/src/run-trigger.service.ts:31,112,125`); the dedup id format `${ticketId}:${agentId}` is meaningless for a null ticket anyway. Idempotency in depth for the generate action = (1) request-level validation in the endpoint (active setup run exists → 409), (2) queue-level `jobId=runId` (unchanged), (3) new DB partial unique index (D3).

**Rationale**: 010 already established that retained BullMQ dedup jobs swallow legitimate re-triggers for non-poller sources; the manual generate action has the same shape. The three-layer principle (Constitution II) is preserved with the endpoint check standing in for webhook dedup (there is no webhook on this path — same argument as manual test-run/retry).

**Alternatives**: a synthetic dedup id `setup:${workspaceId}` on the queue — rejected: retained-job swallow after a completed setup would block regeneration after agent deletion (edge case in spec), and the DB index already gives the hard guarantee.

## D2 — `runs.ticket_id` and `human_tasks.ticket_id` become nullable

**Decision**: Migration `0005` drops NOT NULL on both columns (FKs stay, now nullable). All reads switch from `innerJoin(tickets)` to `leftJoin` on the affected paths: runs list + count (`apps/backend/src/dashboard/runs.controller.ts:60,78`), run card (`:155`), human-tasks list (`human-tasks.controller.ts:64`), worker processor `load()` (`apps/worker/src/claude-cli-run.processor.ts:334`, `run.processor.ts:188`).

**Rationale**: user-confirmed (option "nullable" over synthetic ticket). A synthetic "workspace ticket" row would leak into JQL scope logic, poller diffing, and Jira deep links — worse than teaching ~6 read sites about null.

**Alternatives**: synthetic per-workspace placeholder ticket (rejected: pollutes ticket cache and scope semantics; `agents.controller.ts:314` upsertTicket precedent exists but is for *real* Jira keys); separate `setup_runs` table (rejected: forks the run lifecycle, dedup, executor gate, timeline, UI — everything 010 deliberately kept unified).

## D3 — New partial unique index for ticketless active runs

**Decision**: `runs_one_active` (`libs/database/src/schema/runs.ts:52-54`) stays as-is; it cannot guard NULL ticket rows (Postgres treats NULLs as distinct in unique indexes). Add `runs_one_active_setup`: `UNIQUE (workspace_id) WHERE status IN ('queued','running','awaiting_human') AND ticket_id IS NULL` — at most one active ticketless run per workspace.

**Rationale**: the workspace, not the (ticket, agent) pair, is the natural uniqueness scope for setup. Indexing on `(workspace_id)` alone (not `(workspace_id, agent_id)`) is deliberate: even if a future feature adds other ticketless run kinds, serializing them per workspace is the safe default; relaxing later is an index swap.

**Alternatives**: `(workspace_id, agent_id)` — rejected as weaker for no benefit (only the orchestrator produces ticketless runs today).

## D4 — Run context/wrapper/JWT go ticket-optional, not forked

**Decision**: `RunContext.ticket` (`libs/executors/src/agent-executor.interface.ts:21`) becomes nullable. `buildWrapperText` (`libs/executors/src/claude-cli/wrapper.ts:57`) branches: ticket present → current header; null → workspace-setup header ("You are the workspace orchestrator preparing the agent team for <workspace>…"). `RunTokenClaims.tkt` (`packages/contracts/src/run-token.ts`) becomes optional — `RunTokenGuard` never verified it (`libs/callback/src/run-token.guard.ts:51-86` checks only `sub` + DB status), so this is a claims-shape change with zero auth impact. `featureContextSection` and `fetchTicketDetail` are skipped for ticketless runs.

**Rationale**: one run lifecycle (Constitution/scope rule "keep the abstractions intact"); the executor already supports repo-less runs (`workspace_mode:'none'`, `claude-cli.executor.ts:468`), so ticket-less is the only remaining assumption to relax.

## D5 — Read-only Jira tools: 3 new MCP tools backed by callback endpoints

**Decision**: Extend the callback MCP server (`packages/mcp-server/src/main.ts` — both the `TOOL_DEFS` array `:39-60` and the `switch` dispatch `:72-87`) with three tools, available to **every** callback-wired run:

- `get_project_overview` → `GET api/callbacks/runs/:runId/jira/overview` — board type, workflow statuses, issue types, active sprint (if scrum).
- `search_tickets` → `POST api/callbacks/runs/:runId/jira/search` — parameters `text?`, `status?`, `issue_type?`, `max_results?` (≤50).
- `get_ticket` → `GET api/callbacks/runs/:runId/jira/tickets/:key` — summary, description, status, type, labels, links, last N comments.

All three endpoints sit on the existing `RunTokenGuard` (token → run → `status ∈ {running, awaiting_human}`), resolve the Jira client via `JiraClientFactory.forWorkspace(run.workspaceId)`, and inherit the workspace rate limiter. Input schemas live in `packages/contracts` next to `CallbackTools` (`callback-tools.schema.ts`), so the server keeps its zero-DB, thin-HTTP shape.

**Rationale**: user-confirmed (tools for ALL runs, not a digest-only design). Routing reads through the backend keeps credentials structurally out of the agent's reach (Constitution V) and keeps rate limiting centralized; the guard's DB status re-read already handles token lifetime.

**Alternatives**: a second MCP server dedicated to reads (rejected: double the 0600-config delivery machinery for nothing); handing the agent a scoped Jira token (rejected outright: violates Principle V and the write monopoly's audit trail).

## D6 — Workspace scoping of reads: the system composes the JQL

**Decision**: `search_tickets` accepts structured filters only — never raw JQL. The backend composes `project = <workspace.jiraProjectKey> AND ...` (plus `sprint in openSprints()` for scrum boards, mirroring the poller's scope rules) and calls a new `JiraClient` read method. `get_ticket` verifies the resolved issue's project key matches the workspace before returning (`getIssueContext`-style check). Out-of-scope requests → 403-shaped tool error.

**Rationale**: raw JQL from the model can trivially escape scope (`OR project = X`); composing server-side makes scoping a structural property, not a prompt-behavior hope.

**Alternatives**: JQL sanitization/parsing (rejected: parsing JQL correctly is a project in itself; a compositor is 20 lines).

## D7 — JiraClient gains two read methods; overview reuses existing ones

**Decision**: `BasicAuthJiraClient` (`libs/jira/src/basic-auth-jira.client.ts`) gains:
- `getIssueDetail(key)` → `GET /rest/api/3/issue/{key}?fields=summary,description,status,issuetype,labels,issuelinks,comment` (comments capped to the most recent 20 in the mapper);
- `searchIssues(jql, fields, maxResults)` → thin wrapper over the existing `POST /rest/api/3/search/jql` path with a default field set (`summary,status,issuetype,assignee,updated`) and a hard `maxResults` cap.

The overview endpoint composes **existing** methods: `getBoard` (`:103`), `getActiveSprintId` (`:114`), `getProjectStatuses` (`:172`) + issue types (extracted from the same `/project/{key}/statuses` response, which is already issue-type-shaped).

**Rationale**: the current `getIssue` (`:157`) returns summary+description only and `getFeatureContext` returns link stubs — neither carries comments; extending the client (not bypassing it) keeps the rate limiter and error taxonomy in one place.

## D8 — Response size bounds

**Decision**: hard truncation with explicit `…[truncated]` markers, applied in the backend mappers (not the MCP server): description ≤ 4000 chars, each comment ≤ 1500, comments ≤ 20 (newest first), search ≤ 50 items, overview statuses/types unbounded (they are small by nature). Truncation flags surface in the tool response (`truncated: true`).

**Rationale**: FR-011; bounds match the handoff budget philosophy of 010 (`handoff.ts:46-50`).

## D9 — Team proposal: new report outcome `team`, validated at completion-accept time with a 422 feedback loop

**Decision**: `ReportSchema` gains outcome `'team'` with payload `team: { agents: TeamAgent[] (min 1, max 20) }`, `superRefine`: `team ⇒ payload required` (mirrors `routed`/`needs_human`). `TeamAgent` = `{ name ≤200, description ≤500, instruction ≤8000, trigger_status, status_running?, status_success, status_failure, executor: string /* profile NAME */ }` (`.strict()`).

**Business validation runs synchronously at completion time**, inside the accept path (`RunsService.finalizeWithReport`, the seam both the callback `complete()` and in-worker executors converge on — `libs/runs/src/runs.service.ts:72`): proposal invalid → the completion is **rejected as a 422 validation error carrying the issue list**, exactly like a schema-invalid report. The agent sees the errors through the `complete_task` tool result and can fix and re-submit within the same run. A setup run that ends without an accepted proposal falls into the existing fail-closed path (exit without `complete_task` → `failed` + diagnostics) and the orchestrator-failure human task (D12).

Validation rules (all-or-nothing): names unique within the proposal AND against every existing agent of the workspace (orchestrator included; the DB `agents_workspace_name` unique is the backstop — note today a duplicate name 500s because the linter doesn't check names, `packages/contracts/src/agent-linter.ts:71` — the proposal validator closes that hole); every referenced status exists on the live board (reuse `lintAgent` + `StatusesService.get({refresh:true})`, same as `AgentsController.lintOrThrow`); `executor` resolves by name to an existing **enabled** profile; no orchestrator standing; `duplicate_trigger` lint across the proposal + existing enabled agents.

**Rationale**: this refines spec FR-017 for the better: a rejected `complete_task` gives the model a repair loop (the same property forced-tool-call repair loops rely on), instead of burning the whole run on a typo'd status name. It also keeps Constitution IV intact — the run is complete only when a valid (schema **and** business) report is accepted; no post-finalize status demotion is needed. The spec's FR-017 is amended accordingly (validation errors reach the agent first; a run that never lands a valid proposal fails with the errors surfaced in the failure human task).

**Alternatives**: (a) finalize `succeeded` then pipeline overrides to `failed` — rejected: a succeeded→failed demotion violates the guarded-finalization discipline (CLAUDE.md rule 7) and makes replay reasoning ugly; (b) 010-style "override to human task, run stays succeeded" — rejected: unlike a routed decision, an invalid proposal leaves NOTHING applied, and calling that run "succeeded" misreports reality; (c) interactive `create_agent` callback tools — rejected: loses atomicity, needs rollback of partial teams.

## D10 — Proposal application: one transaction, inside the accept path; review task included

**Decision**: On a valid proposal (validated and applied under the same transaction to close the validate/apply race): insert all agents (`enabled=true`, `behavior.repository` defaulted like the UI path, `executor_id` resolved from the profile name) + insert the non-blocking review human task (`kind='review'`, `blocking=false`, `ticket_id=NULL`, `run_id=<setup run>`, title "Team assembled — review the workspace") + finalize the run `succeeded` — atomically. The pipeline's `onRunFinished` orchestrator branch (`pipeline.service.ts:191`) gains a `workspace-setup` case that only writes the completion marker (`run_events type='jira_action'`, payload `{setup: 'applied', agents_created: n}`) — no Jira writes exist on this path, and replay (drift repair) no-ops on the marker (`hasJiraActionMarker`, `:461`). Scrubbing: `scrubReport` (`libs/callback/src/callback.service.ts:28-51`) extends to `team.agents[].{description,instruction}`; names/statuses/executor refs are identifiers and stay unscrubbed (same reasoning as `target_agent`, `:47`).

**Rationale**: FR-016 atomicity; marker-based replay idempotency is the established 010 pattern; agents write nothing directly (Constitution III untouched — there are no Jira writes at all in setup).

**Alternatives**: apply in `onRunFinished` (after finalize) — rejected: a crash between finalize and apply leaves a succeeded setup run with no team and no failure signal; the accept-path transaction makes "succeeded ⇔ team exists" an invariant.

## D11 — Generate endpoint + UI surface

**Decision**: `POST /api/workspaces/:id/generate-agents` (`DashboardTokenGuard`), preconditions: workspace exists; zero non-orchestrator agents; enabled orchestrator; no active setup run. Success → `202 {run_id}`; violations → `409 {error: reason}`. Trigger via `RunTriggerService.trigger({ticketId: null, agentId: orchestrator.id, triggerEvent: {source:'workspace-setup', mock_scenario?}})` (signature goes ticket-optional per D2/D4).

UI: button in `AgentsList.vue` header (next to "New agent", `apps/web/src/views/AgentsList.vue:56-61`), shown when the loaded agent list contains only the orchestrator; its running/disabled state driven by the runs query — the runs list endpoint gains an optional `source` filter (`trigger_event->>'source'`), so `useRuns(workspaceId, {source:'workspace-setup'})` piggybacks on the existing 5s polling. On completion the user lands in the (new since 9c60684) workspace-scoped **Human queue** tab where the review task sits.

**Rationale**: reuses the manual-trigger seam (`test-run`/`retry` precedent) and the existing polling infrastructure; no new live channel.

## D12 — Setup-run failure & resume semantics

**Decision**: `onOrchestratorFinished` (`pipeline.service.ts:309`) already routes failed/timed-out orchestrator runs to a non-blocking human task (`:332-339`) — setup runs inherit that with a setup-specific message; `decideTriage` is never reached (no ticket). `HumanTaskService.transitionAndComment`'s ticket lookup null-guards and skips Jira (its `if (!agent || !ticket) return` shape already exists, `human-task.service.ts:127-132` — extended to tolerate `ticketId IS NULL`). Blocking `request_human` from a setup run parks it as usual (`parkRun`, `:106-114`).

Resume: `ResumeService.resolve` (`libs/human-tasks/src/resume.service.ts:62`) currently sends any orchestrator-parked run down the **answer-triage** path (`:187`). New rule ahead of that branch: parked run with `trigger_event.source === 'workspace-setup'` → the resumed run is another `workspace-setup` run carrying `human_task_id` + `resolution`; `target_agent_id` is rejected for ticketless tasks (there is no ticket to route). The `ResumeAgentPicker` is hidden for ticketless tasks in `HumanQueue.vue`.

**Rationale**: FR-020; answer-triage semantics (roster, budget exemption, rework routing) are meaningless without a failing worker run and a ticket.

## D13 — Setup handoff: digest + protocol

**Decision**: `buildHandoffSection` (`libs/pipeline/src/handoff.ts:21`) gains a `workspace-setup` branch: (1) project digest — board type + project key (workspace row), workflow statuses (`StatusesService`), repositories (`settings.repositories`), enabled executor profiles (name/type/model from `executors`); (2) the setup decision protocol (how to use the read tools; the `team` contract; naming/status rules; "ask via request_human if the project is empty/ambiguous"); (3) on resume — the parked question + the operator's answer (reuses `questionAnswerLines`, `:259`). Best-effort, size-bounded like every other branch. Issue types / sprint are deliberately left to the read tools (the digest stays compact and DB/cache-served; only statuses come from the existing statuses cache).

**Rationale**: FR-012; keeps prompt assembly non-blocking on Jira (digest degrades; tools carry the deep reads).

## D14 — Workspace created paused; no new display-state machinery in v1

**Decision**: `WorkspacesController.create` (`workspaces.controller.ts:79-119`) writes `settings: { repositories, enabled: false }`; `ConfigSeeder.seed` does the same for newly seeded workspaces (existing rows untouched). The workspace list keeps exactly two states (Running/Paused); no derived "Setting up"/"Ready for review" badges in v1 — the workspace page communicates setup progress through the Runs tab / generate button state (D11) and the review task in the Human queue tab.

**Rationale**: the deferred design point from the spec resolves to "nothing extra": both candidate signals (active setup run, open review task) are already visible one tab away, and a derived tri-state on the list row would need the very cross-request aggregation the list's `toResponse` N+1 already struggles with. Revisit post-v1 if the two-state row proves confusing.

## D15 — Mock executor & tests

**Decision**: `MOCK_SCENARIOS` gains `'team'` (valid proposal — agent roster threaded through `trigger_event` or `behavior`, mirroring how `routed` threads `target_agent`, `mock.executor.ts:56-63`) and `'team_invalid'` (proposal referencing a bogus status → exercises the 422-reject → fail-closed path). Integration coverage (real Postgres/Redis, mock Jira): full generate→propose→apply→review loop; concurrent-generate race (SC-003); atomic-rejection (SC-004); replay no-op (SC-007); paused-workspace-never-polls (SC-002); read-tool endpoints incl. scope rejection and truncation (SC-005); ticketless rendering contracts. Web tests: null-ticket fixtures in `apps/web/test/handlers.ts`, generate-button states, picker hidden on ticketless tasks.

**Rationale**: Constitution VI; every listed path is pipeline logic.

## D16 — Contract/API deltas for null tickets

**Decision**: `RunTicketRefSchema` usage flips to `ticket: RunTicketRefSchema.nullable()` on `RunListItem`/`RunCardResponse` (`packages/contracts/src/runs.schema.ts:36,46,116`); same for `HumanQueueItem.ticket` (`human-queue.schema.ts:21,31`). Web null-guards + "Workspace setup" label at the four render sites (`Runs.vue:139-141`, `RunCard.vue:121-122`, `HumanTaskRow.vue:49-53`, `HumanTaskDrawer.vue:33-35`). The runs-list ticket-key text filter simply never matches setup runs (`ilike` on a left-joined column — NULL never matches): acceptable and documented; the new `source` filter (D11) is the way to find them.

## D17 — Documentation set

**Decision**: same-change updates: `docs/architecture.md` §3 (nullable ticket refs + `runs_one_active_setup`), §5 (three read tools in the callback protocol), §6 (`team` outcome in ReportSchema); `drizzle/0005_workspace_setup.sql` + `REVIEW-0005_workspace_setup.md`; `docs/plan-internal.md` gets the feature as its own iteration row (slotting relative to 12–13 executors is the owner's call at merge time); `docs/progress.md` journal entry at implementation checkpoint.

---

### Resolved spec deviations

- **FR-017 amended** (see D9): an invalid proposal is first rejected back to the agent as a `complete_task` validation error (repair loop within the run); only a run that ends without an accepted proposal becomes `failed`, with the last validation errors recorded and surfaced in the failure human task. `spec.md` updated in the same commit as this research.

# Feature Specification: Runs Visibility & Human Queue

**Feature Branch**: `006-runs-human-queue`

**Created**: 2026-07-12

**Status**: Draft

**Input**: User description: "Feature 006: runs visibility & human queue — the operational half of the dashboard: a Runs tab inside each workspace, a run/ticket card with checklists and timeline, the human-task queue with resolution actions, executors administration (iteration-5 debt), and the multi-workspace worker loop (iteration-5 debt). Acceptance criterion: product pains #2 (unreadable agent reports) and #3 (no unified needs-human queue) are closed."

## Overview

BRIGADIR already runs agent pipelines against Jira and records every run, checklist item, timeline event, and human task in Postgres (architecture §3). Feature 004 shipped the full human-task lifecycle behind `POST /api/human-tasks/:id/resolve` (backend only). Feature 005 shipped the dashboard shell, the static-bearer guard, and per-workspace Jira client resolution (`JiraClientFactory.forWorkspace`). **What is missing is the operator's window into all of that data** — plus two recorded iteration-5 debts that block real operation.

This feature delivers the operational half of the dashboard so a team member can, without touching the database or Jira directly: watch runs as they happen, read an agent's report as a scannable checklist, understand why a run failed, and clear the queue of tasks that need a human — closing product pains **#2 (agent reports are unreadable)** and **#3 (there is no unified needs-human queue)**. It also pays down the two debts that keep the tool single-workspace and unable to configure executors from the UI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Clear the needs-human queue (Priority: P1)

An operator opens the dashboard and immediately sees every task that an agent has escalated to a human — questions, blockers, and review requests — across all workspaces, in one list. For each task they read the context (title, ticket, agent, kind, how long it has been waiting, whether a run is blocked on it), type an answer, and choose an action: **resume** the run with their answer, mark it **done manually**, or **dismiss** it. A blocking task's resume drives the real feature-004 resume path (a new run attempt continues the ticket). A badge in the navigation shows the count of open tasks so nothing is silently missed.

**Why this priority**: This closes product pain #3 outright and is the single most valuable operational capability — an escalated task that no one sees stalls a whole pipeline. It is independently testable and delivers value even if nothing else in this feature ships.

**Independent Test**: Seed open human tasks of each kind (question/blocker/review, blocking and non-blocking) via the existing backend, load the human-queue page, resolve a blocking task with "resume" + an answer, and verify a new run attempt is created and the ticket progresses; verify the badge count decrements and the resolved task moves to history.

**Acceptance Scenarios**:

1. **Given** open human tasks exist, **When** the operator opens the dashboard, **Then** the human queue is the default landing view and lists every open task with title, ticket key, agent, kind, age, and a blocking indicator.
2. **Given** a blocking task for a paused run, **When** the operator submits an answer with action "resume", **Then** the run continues via the existing resolve path and the task disappears from the open list.
3. **Given** any open task, **When** the operator chooses "done manually" or "dismiss", **Then** the task is closed with that resolution and no run is resumed.
4. **Given** open tasks exist, **When** any task's open/closed state changes, **Then** the navbar badge reflects the new open-task count within a few seconds without a manual page refresh.
5. **Given** resolved and dismissed tasks exist, **When** the operator switches to the history filter, **Then** closed tasks are visible with their resolution and resolver.

---

### User Story 2 - Read an agent's report and diagnose a run (Priority: P1)

An operator opens a run/ticket card and sees the agent's structured report rendered as a scannable checklist — each item marked ✅ pass, ❌ fail, ⚠ warn, or ⏭ skip, with the reason available on expand — instead of a wall of raw text. The card shows the ticket header (key, summary, deep link to Jira, current run status), the full run history for that ticket (agent, executor, attempt, duration, cost, outcome per run), a timeline of what the agent did (progress stages, tool calls, api retries, Jira actions), and, for a failed run, the stderr/diagnostics needed to understand the failure. From the card the operator can cancel a running run or retry a finished one.

**Why this priority**: This closes product pain #2 outright — the report is the product's core output and it is currently unreadable. Independently valuable: even without the runs list, a direct link to a ticket card lets an operator understand and act on any run.

**Independent Test**: Seed a ticket with runs carrying report checks in all four states, timeline events, and a failed run with stderr; open the card by ticket; verify all four check glyphs render, reasons expand, the timeline and run history display, failure diagnostics show for the failed run, and cancel/retry trigger the existing backend paths.

**Acceptance Scenarios**:

1. **Given** a run with a structured report, **When** the operator opens its ticket card, **Then** each report check renders with the correct glyph (✅/❌/⚠/⏭) and its reason is revealed on expand.
2. **Given** a ticket with multiple runs, **When** the card loads, **Then** the run history lists each run's agent, executor, attempt, duration, cost, and outcome, and the header links to the ticket in Jira.
3. **Given** a run with timeline events, **When** the operator views the card, **Then** progress stages, tool calls, api retries, and Jira actions appear in chronological order.
4. **Given** a failed run, **When** the operator opens it, **Then** stderr/diagnostics are shown.
5. **Given** a running run, **When** the operator clicks cancel, **Then** the run row is flipped off "running" so the existing cancel poll finalizes it; **Given** a finished run, **When** the operator clicks retry, **Then** the existing manual-trigger path creates a new attempt.

---

### User Story 3 - Browse and filter runs in a workspace (Priority: P2)

An operator selects a workspace and opens its Runs tab — a table of runs showing agent, ticket (key + summary, deep link to Jira), run status, attempt, duration, and cost. They narrow the list by agent and by run status, search by ticket key, and page through results. The table updates live as runs start, progress, and finish. Clicking a row opens that run's ticket card (User Story 2). The tab header shows a simple total-cost figure for the workspace over a selectable period.

**Why this priority**: The runs table is the primary navigation surface into the cards and the workspace's operational overview, but a direct ticket link (US2) and the human queue (US1) already deliver the core pains, so this is P2.

**Independent Test**: Seed a workspace with runs across several agents and statuses; load the Runs tab; apply an agent filter, a status filter, and a ticket-key search and verify the rows narrow correctly; change the cost period and verify the total updates; click a row and verify the ticket card opens.

**Acceptance Scenarios**:

1. **Given** a workspace with runs, **When** the operator opens the Runs tab, **Then** a paginated table shows agent, ticket key + summary (linked to Jira), run status, attempt, duration, and cost per run.
2. **Given** the runs table, **When** the operator filters by agent, filters by run status, or searches by ticket key, **Then** the rows narrow to matching runs and pagination reflects the filtered set.
3. **Given** the runs table is open, **When** a run changes status, **Then** the affected row reflects the change within a few seconds without a manual refresh.
4. **Given** the Runs tab, **When** the operator selects a cost period, **Then** the header shows the workspace's total run cost over that period.
5. **Given** the runs table, **When** the operator clicks a row, **Then** that run's ticket card opens.

---

### User Story 4 - Administer executors and never see an empty executor picker (Priority: P2)

An operator manages a workspace's executors from workspace settings: list, create, update, and delete them, with a typed configuration form per executor type (a mock executor exposes only concurrency; a claude_cli executor exposes model, CLI path, a repository chosen from the workspace's repositories, callback-channel toggle, keep-failed-worktrees toggle, max turns, and concurrency limit). When a workspace is created it is seeded with a sensible default executor set so the agent form is never blocked. The agent form's executor picker reads from the executors endpoint (not the old discovery workaround), shows executor **names** with a type badge (never raw UUIDs), and defaults to the workspace's claude_cli executor. Deleting an executor that agents reference is rejected with a clear message. Changing an executor's concurrency limit takes effect on the live worker without a restart.

**Why this priority**: Iteration-5 debt. Without it, a fresh workspace from the wizard cannot create an agent at all (the executor picker is empty). It is foundational but gated behind having a workspace, so P2.

**Independent Test**: Create a workspace and verify a default claude_cli ("claude") and mock ("mock") executor exist; open the agent form and verify the picker shows those names with type badges and defaults to claude_cli; create/update/delete executors via the endpoints; attempt to delete a referenced executor and verify rejection; change concurrency and verify the running worker applies the new limit without restart.

**Acceptance Scenarios**:

1. **Given** a newly created workspace, **When** its executors are listed, **Then** exactly one claude_cli executor named "claude" and one mock executor named "mock" exist by default.
2. **Given** an executor type, **When** the operator opens its config form, **Then** only that type's fields are shown (mock: concurrency; claude_cli: model, CLI path, repository select, callback toggle, keep-failed-worktrees toggle, max turns, concurrency limit).
3. **Given** any workspace with executors, **When** the operator opens the agent form's executor picker, **Then** it lists executor names each with a type badge, defaults to the workspace's claude_cli executor, and never shows a raw UUID or an empty list.
4. **Given** an executor referenced by one or more agents, **When** the operator tries to delete it, **Then** the deletion is rejected with a clear error naming the conflict.
5. **Given** a running worker, **When** the operator changes an executor's concurrency limit, **Then** the new limit is applied to the live worker without a restart.

---

### User Story 5 - Poll every enabled workspace, isolate outages (Priority: P2)

The worker's reconcile pass processes **every enabled workspace** each pass — each with its own board scoping, high-water mark, dependency re-evaluation, watchdog, and drift repair — instead of a single workspace. A disabled workspace is skipped entirely. One workspace's Jira outage does not prevent the other workspaces' passes from completing. The workspace pause (enabled) toggle is available in workspace settings.

**Why this priority**: Iteration-5 debt. Today the reconcile pass handles only one workspace (`reconcile.service.ts` `.limit(1)`), so a second workspace is never polled. Essential for multi-workspace operation but invisible in the single-workspace happy path, so P2.

**Independent Test**: With two enabled workspaces and one disabled, run one reconcile pass and verify both enabled workspaces were polled and the disabled one skipped; make one enabled workspace's Jira fail and verify the other still completes its pass.

**Acceptance Scenarios**:

1. **Given** two enabled workspaces, **When** one reconcile pass runs, **Then** both are polled, each with its own board scope, high-water mark, dependency re-eval, watchdog, and drift repair.
2. **Given** an enabled and a disabled workspace, **When** a reconcile pass runs, **Then** the disabled workspace is skipped entirely.
3. **Given** two enabled workspaces where one's Jira is unavailable, **When** a reconcile pass runs, **Then** the healthy workspace's pass still completes.
4. **Given** workspace settings, **When** the operator toggles a workspace's enabled state, **Then** the reconcile pass includes or excludes it accordingly on the next pass.

---

### Edge Cases

- **Live-update transport (planning decision)**: The live-update mechanism is chosen during planning, not fixed here. EventSource cannot send an Authorization header and the project's privacy rule forbids the bearer token in a query string; planning must choose among header-capable fetch streaming, a short-lived SSE ticket endpoint, or polling via query refetch — favoring simplicity for an internal tool. Whatever is chosen, the runs table, the run card, and the human-queue badge MUST reflect changes within a few seconds without a manual refresh.
- **Retry semantics**: Retry is offered only for runs whose state can accept a new attempt (per the existing manual-trigger path). The card MUST NOT offer retry where the three-level idempotency guards would reject a second active run.
- **Cancel race**: Cancel flips the run row off "running" for the existing poll to finalize; it MUST NOT overwrite an `awaiting_human` run (per constitution — outcome-derived status writes are guarded to `running`).
- **Concurrency re-apply**: If several executors of one type exist, the live concurrency applied is the sum of their limits (matching the boot-time wiring).
- **Empty states**: No open human tasks → the human queue is not forced as the landing view and shows an empty state; a workspace with no runs → the Runs tab shows an empty state, not an error.
- **Deep links**: A ticket's Jira link and a run's external session reference (when present) open the correct external target; a missing summary or cost renders gracefully.
- **Report with no checks / partial report**: A run whose report has no checklist items or is missing fields renders the available parts without breaking the card.
- **Workspace Jira outage during a pass**: A per-workspace Jira/board-introspection failure logs and is skipped for that pass only (retried next interval), never aborting the loop.

## Requirements *(mandatory)*

### Functional Requirements

#### Human queue (US1)

- **FR-001**: The system MUST provide a global human-queue view listing all open human tasks across workspaces, each showing title, ticket, agent, kind (question/blocker/review), age, and blocking flag.
- **FR-002**: The human queue MUST be the default landing view when at least one open human task exists.
- **FR-003**: Each open task MUST offer a resolution form with a free-text answer and an action choice of resume, done_manually, or dismiss, submitted through the existing `POST /api/human-tasks/:id/resolve` endpoint.
- **FR-004**: Resolving a blocking task with "resume" MUST drive the existing feature-004 resume path so the blocked run continues as a new attempt.
- **FR-005**: The navigation MUST show a badge with the current count of open human tasks, updated live within a few seconds of any open/closed change.
- **FR-006**: Closed (resolved/dismissed) tasks MUST be viewable via a history filter, showing their resolution and resolver.

#### Run/ticket card (US2)

- **FR-007**: The run/ticket card MUST show a header with ticket key, summary, a deep link to the ticket in Jira, and the current run status.
- **FR-008**: The card MUST render the run's structured report as a checklist, each item shown as ✅ pass / ❌ fail / ⚠ warn / ⏭ skip with its reason revealed on expand.
- **FR-009**: The card MUST list the ticket's run history, showing per run: agent, executor, attempt, duration, cost, and outcome.
- **FR-010**: The card MUST render the run's event timeline from run events in chronological order, including progress stages, tool calls, api retries, and Jira actions.
- **FR-011**: For a failed run, the card MUST show stderr/diagnostics.
- **FR-012**: The card MUST offer a cancel action for a running run that flips the run off "running" for the existing cancel poll to finalize, without overwriting an `awaiting_human` state.
- **FR-013**: The card MUST offer a retry action for an eligible finished run that invokes the existing manual-trigger path to create a new attempt.
- **FR-014**: The card MUST reflect run status, new events, and report changes live within a few seconds without a manual refresh.

#### Runs tab (US3)

- **FR-015**: Each workspace MUST provide a Runs tab (replacing the placeholder route) with a paginated table of runs showing agent, ticket (key + summary with a Jira deep link), run status, attempt, duration, and cost.
- **FR-016**: The runs table MUST support filtering by agent, filtering by run status, and searching by ticket key, with pagination reflecting the filtered set.
- **FR-017**: The runs table MUST update live within a few seconds as runs start, progress, and finish, without a manual refresh.
- **FR-018**: Clicking a run row MUST open that run's ticket card.
- **FR-019**: The Runs tab header MUST show a total run-cost figure for the workspace over an operator-selectable period.

#### Executors administration (US4)

- **FR-020**: The system MUST provide REST endpoints to list, create, update, and delete executors scoped to a workspace.
- **FR-021**: Workspace settings MUST include an Executors section with a typed configuration form per executor type — mock: concurrency only; claude_cli: model, CLI path, repository (selected from the workspace's repositories), callback-channel toggle, keep-failed-worktrees toggle, max turns, and concurrency limit.
- **FR-022**: Creating a workspace MUST seed a default executor set of exactly one claude_cli executor named "claude" and one mock executor named "mock".
- **FR-023**: The agent form's executor picker MUST read from the executors endpoint (replacing the discovery workaround), display executor names each with a type badge (never raw UUIDs), never present an empty list, and default to the workspace's claude_cli executor.
- **FR-024**: Deleting an executor referenced by one or more agents MUST be rejected with a clear error identifying the conflict.
- **FR-025**: Changing an executor's concurrency limit MUST re-apply to the live worker without a restart; where multiple executors of one type exist, the applied concurrency is the sum of their limits.

#### Multi-workspace worker (US5)

- **FR-026**: The reconcile pass MUST iterate all enabled workspaces, performing per workspace its own board scoping, high-water mark tracking, dependency re-evaluation, watchdog, and drift repair (replacing the single-workspace `.limit(1)` selection).
- **FR-027**: The reconcile pass MUST use a per-workspace Jira client via the existing `JiraClientFactory.forWorkspace` pattern on the worker side.
- **FR-028**: A disabled workspace (enabled = false) MUST be skipped entirely by the reconcile pass.
- **FR-029**: A single workspace's Jira outage (or board-introspection failure) MUST NOT prevent other workspaces' passes from completing; it is logged and skipped for that pass only.
- **FR-030**: Workspace settings MUST expose the workspace enabled/paused toggle (if not already shipped in feature 005).

#### Cross-cutting

- **FR-031**: Live updates MUST use a single mechanism chosen during planning that does not transmit the bearer token in a URL query string and is compatible with the static-bearer guard.
- **FR-032**: All new endpoints and views MUST enforce the existing static-bearer authentication and remain scoped to the caller's workspace where the resource is workspace-scoped.
- **FR-033**: The system MUST NOT change the run execution or callback protocol (owned by features 003–004); this feature only reads run/report/event/human-task data and invokes the existing resolve, cancel, and manual-trigger paths.
- **FR-034**: The system MUST NOT introduce a kanban board or a read-only copy of the Jira board; Jira remains the only board (decision #4).

### Key Entities *(existing data — architecture §3; no schema change required)*

- **Executor**: A per-workspace runner configuration (type, name, non-secret config, encrypted secrets, concurrency limit, enabled). Referenced by agents. New in this feature: full CRUD surface and default seeding; no column change.
- **Run**: A single agent execution on a ticket (agent, executor type, status, attempt, timings, cost, usage, report, outcome). Read for the runs table and card; cancel/retry drive existing paths.
- **Run check**: One checklist item of a run's report (position, name, status pass/fail/warn/skip, reason). Rendered as the checklist.
- **Run event**: One timeline entry of a run (type: progress/log/tool_call/api_retry/error/jira_action, payload, time). Rendered as the timeline.
- **Human task**: An escalation from a run to a human (kind, title, details, blocking flag, status open/resolved/dismissed, resolution, resolver). Listed and resolved in the human queue.
- **Workspace**: Owns executors, agents, tickets, runs, and the enabled flag that gates the reconcile pass and repositories used by executor config.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can find and resolve any open needs-human task from a single view without querying the database or Jira directly — product pain #3 is closed.
- **SC-002**: An operator can understand an agent's report — which checks passed, failed, warned, or were skipped, and why — from the checklist without reading raw report text — product pain #2 is closed.
- **SC-003**: For a failed run, an operator can identify the failure cause from the card's diagnostics without shell access to the worker.
- **SC-004**: Resolving a blocking task with "resume" results in the blocked run continuing (a new attempt is created) with no manual database or queue intervention.
- **SC-005**: The runs table, the run card, and the human-queue badge reflect run/task state changes within a few seconds without a manual page refresh.
- **SC-006**: A newly created workspace can have an agent created immediately — the executor picker is populated with named executors and defaults to claude_cli — with no agents.yaml import or manual executor row.
- **SC-007**: In one reconcile pass with two enabled workspaces and one disabled, both enabled workspaces are polled and the disabled one is skipped; when one enabled workspace's Jira is down, the other still completes its pass.
- **SC-008**: Changing an executor's concurrency limit changes the live worker's applied concurrency without a process restart.
- **SC-009**: Deleting an executor referenced by an agent is refused with an actionable message; no orphaned agent references result.
- **SC-010**: Each run's cost is visible in both the table and the card, and a workspace's total run cost over a selected period is shown on the Runs tab header.

## Assumptions

- **Data is already present**: `runs`, `run_checks`, `run_events`, `human_tasks`, and `executors` (architecture §3) already hold all data this feature displays; no schema migration is required. If a read query needs a supporting index, that is an implementation detail, not a schema change.
- **Backend lifecycle exists**: The feature-004 human-task lifecycle (`resolve` with resume/done_manually/dismiss) and the run cancel and manual-trigger (retry) paths already exist and are reused unchanged.
- **Auth model**: A single static bearer token (feature 005) authenticates the dashboard; no per-user auth in this feature.
- **Live-update mechanism is a planning decision**: Selected during `/speckit-plan` from header-capable fetch streaming, a short-lived SSE ticket endpoint, or query-refetch polling, biased to simplicity; the requirement is "reflects changes within a few seconds without manual refresh," not a specific transport. The prior spec assumption of raw SSE is superseded by the bearer-in-query-string privacy constraint.
- **Cost period presets**: The Runs-tab cost period offers reasonable presets (e.g., 24h / 7d / 30d) plus current selection; exact presets are a UI detail.
- **Default executor config**: The seeded "claude" (claude_cli) and "mock" executors use sensible defaults; the claude_cli default repository is the workspace's default repository when one exists.
- **Deep links**: Ticket Jira links are built from the workspace's Jira site URL and ticket key already stored.
- **Testing follows the established pattern**: Backend endpoints and the multi-workspace reconcile use testcontainers + mock-jira (no broker mocks); frontend uses component tests with msw-faked APIs — per constitution Principle VI and CLAUDE.md rule 4.
- **Out of scope (deferred to 8+)**: kanban board (never), stats widgets/dashboards beyond the lite cost figure, Slack notifications, workspace budget ceilings/enforcement, `--resume` session reuse, and any change to the run execution/callback protocol.

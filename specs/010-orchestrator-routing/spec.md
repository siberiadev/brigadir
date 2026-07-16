# Feature Specification: Orchestrator-Based Blocked-Ticket Routing ("brigadir" agent)

**Feature Branch**: `010-orchestrator-routing`

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: "Orchestrator-based blocked-ticket routing ('brigadir' agent). Today, when an agent run fails (e.g. a Reviewer finds a HIGH defect), the ticket transitions to the agent's status_failure ('Blocked') and dies there: the fix details live only in the run report and PR comments, and nothing picks the ticket up. This feature adds automated triage and rework routing: a per-workspace orchestrator agent that receives the failing run's report and the workspace agent roster, and decides to route the ticket back to a worker agent with a written rework task or escalate to a human; automatic handoff context injection so no worker agent needs routing knowledge in its instructions; a hard rework-cycle cap; an agent picker in the Human Queue resume flow; and a centrally configurable default orchestrator instruction."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Failed run is automatically triaged and routed for rework (Priority: P1)

A worker agent's run fails on a ticket (for example, a Reviewer rejects the Developer's PRs with a concrete correctness finding). Instead of the ticket dying in Blocked, the system automatically starts a triage run by the workspace's orchestrator agent ("brigadir"). The orchestrator sees the failing run's report (summary, failed/warning checks, branch/PR artifacts), the roster of available worker agents with their descriptions, and how many rework cycles the ticket has already consumed. It decides to send the ticket back to a specific worker agent together with a written, self-contained rework task. That worker agent's new run automatically receives the rework task and the failure context in its prompt — framed explicitly as a fix of existing work (continue on the existing branch/PR), not a fresh implementation — without any changes to the worker agent's own instruction.

**Why this priority**: This is the core value of the feature — closing the loop on blocked tickets that today require a human to notice, re-read the review findings, and manually restart work. It is the reason the feature exists.

**Independent Test**: Using the mock executor, fail a worker run on a ticket, verify exactly one triage run is created for the orchestrator; complete the triage run with a routing decision targeting a worker agent, and verify a rework run is created for that agent, the ticket moves to that agent's running status, and the rework run's prompt contains the orchestrator's task text and the failing run's report context.

**Acceptance Scenarios**:

1. **Given** a workspace with an enabled orchestrator agent and a ticket whose worker run finishes terminally failed, **When** the pipeline processes the run's completion, **Then** the ticket transitions to the failing agent's failure status (as today), the failure comment is posted (as today), and exactly one triage run for the orchestrator agent is enqueued in-process (no polling delay).
2. **Given** a triage run in progress, **When** the orchestrator's prompt is assembled, **Then** it contains a handoff section with: the failing run's report summary, its failed and warning checks, its branch/PR artifacts, the workspace's worker-agent roster (name + description), the ticket's rework-cycle count against the maximum, and the decision protocol — all injected automatically, with no roster or protocol text in the orchestrator's stored instruction.
3. **Given** a triage run that completes with a routing decision naming an existing enabled worker agent and a rework task, **When** the pipeline processes it, **Then** a rework run is created for the target agent carrying the task and a reference to the failing run, the ticket transitions to the target agent's running status without re-triggering via polling, and a routing comment is posted on the Jira issue.
4. **Given** a rework run for a worker agent, **When** its prompt is assembled, **Then** it contains a handoff section with the orchestrator's task text, the failing run's summary and failed checks, the branch/PR to continue on, and explicit framing that this is a fix of existing work — while the worker agent's stored instruction is unchanged.
5. **Given** the pipeline's completion processing is replayed for the same failed run (drift repair), **When** it runs again, **Then** no second triage run is created.

---

### User Story 2 - Rework loops are hard-capped with human fallback (Priority: P2)

Rework cycles cannot ping-pong forever between a worker and the orchestrator. The system enforces a per-ticket maximum number of rework cycles (default 2) in deterministic pipeline code — not by trusting the orchestrator model. When the budget is exhausted, or the orchestrator's decision is invalid (unknown/disabled target agent), or the orchestrator run itself fails, the ticket is escalated to a human task instead of another automated attempt.

**Why this priority**: Without this guard the P1 loop is unsafe to run unattended — a ticket the agents cannot actually fix would burn tokens indefinitely.

**Independent Test**: Drive a ticket through the maximum number of rework cycles with the mock executor and verify the next failure produces a human task and no triage run; complete a triage run with an invalid target and verify the override to a human task.

**Acceptance Scenarios**:

1. **Given** a ticket that has already consumed its rework-cycle budget, **When** another worker run fails on it, **Then** no triage run is created and a non-blocking human task is created instead, with the decision recorded on the run's timeline.
2. **Given** a triage run that returns a routing decision naming a non-existent, disabled, or orchestrator target agent, **When** the pipeline processes it, **Then** the decision is overridden into a human task containing the orchestrator's task text and the override reason.
3. **Given** a triage run that returns a valid routing decision but the cycle budget was exhausted in the meantime, **When** the pipeline processes it, **Then** the decision is overridden into a human task.
4. **Given** an orchestrator run that itself fails or times out, **When** the pipeline processes it, **Then** no further triage run is created (the triager is never triaged) and a human task is created describing the orchestrator failure.
5. **Given** a worker (non-orchestrator) agent that attempts to return a routing decision, **When** the pipeline processes its report, **Then** the report is treated as a failure and the invalid outcome is noted in the Jira comment.

---

### User Story 3 - Human resolves a blocked ticket by choosing which agent resumes (Priority: P2)

When a ticket lands in the Human Queue (an agent asked for help, or the automated loop escalated), the operator reads the question, writes an answer, and — new — picks which agent should take the ticket next from a dropdown. The dropdown includes the workspace's orchestrator ("brigadir"), **preselected by default** (answer-triage delta): resolving to it creates an *answer-triage* run — the orchestrator reads the Q&A plus the parked run's failure context in its handoff and routes via the ordinary "routed" contract, so the human's decision is interpreted centrally instead of being dumped on one worker. Picking a worker agent instead resumes it directly (original behavior). Either way the human's answer together with the original question is automatically injected into the new run's prompt.

**Why this priority**: This is the manual half of the hybrid model — the human stays in control of genuinely ambiguous blocks, and their answer must not get lost between the queue and the next run.

**Independent Test**: Park a run via a blocking human task, resolve it choosing a different agent, and verify the new run belongs to the chosen agent, the ticket moves to that agent's running status, and the new run's prompt contains the task title/details and the human's answer.

**Acceptance Scenarios**:

1. **Given** an open blocking human task, **When** the operator resolves it with "resume" and no agent selection, **Then** the parked run is superseded and a new run is created for the original agent (current behavior preserved), and the new run's prompt contains the human task's title, details, and the operator's answer.
2. **Given** an open blocking human task, **When** the operator resolves it with "resume" and selects a different enabled worker agent of the same workspace, **Then** the new run is created for the chosen agent (first attempt for that agent), and the ticket transitions to the chosen agent's running status.
3. **Given** a resolve request naming an agent that does not exist, is disabled, or belongs to another workspace, **When** it is submitted, **Then** the request is rejected with a validation error and nothing changes.
4. **Given** the Human Queue UI on a blocking task with action "resume", **When** the operator opens the agent selector, **Then** it lists the workspace's enabled agents including the orchestrator, with the **orchestrator preselected** (falling back to the original agent when the orchestrator is disabled).
5. **Given** an open blocking human task, **When** the operator resolves it with "resume" targeting the orchestrator (explicitly, or implicitly because the parked run belongs to the orchestrator), **Then** the new run is an *answer-triage* run: its trigger references the human task and the failing run, its prompt carries the Q&A + the failure context + the roster + the decision protocol, and no ticket transition happens until the orchestrator's routed decision moves the ticket to the rework target's running status.
6. **Given** an answer-triage run that completes with a valid routing decision, **When** the ticket's rework budget is already exhausted, **Then** the rework run is still created — the human answer grants one extra cycle — and that rework run counts in run history, so the next automatic triage on a subsequent failure escalates with `cycle_limit`.

---

### User Story 4 - Orchestrator agent exists on every workspace and is centrally configurable (Priority: P3)

Every workspace automatically gets an orchestrator agent named "brigadir" — on workspace creation and, for pre-existing workspaces, on system startup. It cannot be deleted (the UI offers no delete action for it; a direct delete attempt is rejected), but its instruction is editable per workspace like any agent's. A platform administrator can also edit the *default* orchestrator instruction in a new "General" section of platform settings; the default is copied into the orchestrator agent at workspace-creation time, so changing it affects newly created workspaces only.

**Why this priority**: Seeding and central configuration make the feature zero-setup and maintainable, but the routing loop (P1/P2) is testable on a manually created orchestrator without them.

**Independent Test**: Create a workspace and verify the "brigadir" agent exists with the default instruction; change the default in General settings, create another workspace, and verify the new default is used while existing agents are untouched; attempt to delete the orchestrator and verify rejection.

**Acceptance Scenarios**:

1. **Given** a new workspace created through the wizard or the configuration file, **When** creation completes, **Then** an orchestrator agent named "brigadir" exists in it, never triggered by board-status polling, with the current default instruction copied in.
2. **Given** a system upgrade onto a database with existing workspaces, **When** the system starts, **Then** each existing workspace is backfilled with an orchestrator agent if it lacks one.
3. **Given** the orchestrator agent, **When** a user attempts to delete it via UI or API, **Then** the UI shows no delete action for it and the API rejects the attempt with a conflict error; editing its instruction, timeout, or enabled flag remains possible.
4. **Given** the platform settings "General" section, **When** the administrator edits the default orchestrator instruction and saves, **Then** workspaces created afterwards seed their orchestrator with the new text, and orchestrator agents of existing workspaces are unchanged.
5. **Given** an orchestrator agent whose instruction the workspace owner has edited, **When** its triage runs execute, **Then** the edited instruction is used (the decision protocol and roster still arrive via the automatic handoff section).

---

### Edge Cases

- **Orchestrator disabled by the user**: triage is skipped (recorded as "no orchestrator"); failures behave as today — ticket stays in Blocked with the failure comment. Disabling the orchestrator is the supported off-switch for automated triage.
- **Ticket with no prior successful runs** (first agent in the chain fails): triage still works — the decision needs only the failing run's report and the roster.
- **Concurrent runs**: a second worker failure while a triage run is already active on the ticket must deduplicate (at most one active run per ticket+agent); routing onto an agent already active on the ticket must deduplicate likewise.
- **Failing run has no structured report** (crashed without reporting): triage receives the synthetic failure report (error diagnostics) — still enough to escalate to a human.
- **Rework run on a repository state that moved on** (target branch merged/deleted): the handoff carries branch and PR references as text; the worker agent handles a missing branch as it would any instruction pointing at repository state.
- **Pre-existing trigger-source mismatch**: the stored trigger-source vocabulary contains a variant ("human_resume") that the resume flow never writes (it writes "human-resume"), which today makes mock-executor resumed runs crash on validation. The vocabulary must be corrected as part of extending it, and resumed mock runs must work.
- **Routing comment or status transition fails in Jira** (board misconfiguration): follows the existing non-fatal transition semantics — the failure is recorded and reconciliation retries; the rework run itself is already safely enqueued exactly once.
- **Answer-triage on a parked orchestrator run** (brigadir's own needs_human, resumed with no explicit target): the effective agent is the orchestrator, so the resume still produces an answer-triage run; the failing-run reference is forwarded from the parked run's own trigger (the original worker failure holds the useful report), falling back to the parked run id.
- **Answer-triage on a run parked by the blocking `request_human` callback** (no persisted report): the handoff degrades best-effort — Q&A, roster, and protocol render; the failure lines are omitted.
- **Answer-triage with the rework budget exhausted**: the orchestrator's routed decision is exempt from the exhausted-budget override (the human answer grants one extra cycle); the handoff states this explicitly. Automatic fail-triage keeps the hard cap.

## Requirements *(mandatory)*

### Functional Requirements

**Routing contract**

- **FR-001**: The run report contract MUST support a fourth outcome, "routed", carrying a routing payload of target agent name (≤200 chars) and a written rework task (≤4000 chars); "routed" without the payload MUST be rejected as invalid, mirroring the existing needs_human/human_task rule. No other routing channel (labels, queries, statuses) is introduced.
- **FR-002**: Only orchestrator runs may effect routing: a "routed" report from a non-orchestrator agent MUST be treated as a failure with the invalid outcome noted in the ticket comment.
- **FR-003**: The routing task text MUST pass the same secret scrubbing as all other report fields before persistence or posting to Jira.

**Triage flow**

- **FR-004**: When a worker run finishes terminally failed (failed or timed out), the pipeline MUST — after the existing failure transition and comment, and before the completion marker — start exactly one in-process triage run for the workspace's enabled orchestrator agent, protected by the existing three idempotency layers, and MUST record the triage decision (triaged / cycle limit / no orchestrator) in the completion marker so replays are no-ops.
- **FR-005**: If the ticket's rework-cycle budget is exhausted or no enabled orchestrator exists, the pipeline MUST create a non-blocking human task instead of a triage run.
- **FR-006**: The rework-cycle count MUST be derived deterministically from the ticket's run history (count of rework-sourced runs), with the per-workspace maximum defaulting to 2 and stored in workspace settings.

**Orchestrator decision processing**

- **FR-007**: A completed orchestrator run MUST NOT trigger the generic success/failure ticket transition; its success/failure status mappings are inert placeholders.
- **FR-008**: On a valid "routed" decision (target exists, enabled, not an orchestrator, same workspace, cycle budget still available), the pipeline MUST enqueue a rework run for the target agent carrying the task text and references to the failing and deciding runs, transition the ticket to the target's running status without passing through any trigger status (poller-safe), and post a routing comment naming the target agent and task.
- **FR-009**: On an invalid target or exhausted budget, the pipeline MUST override the decision into a human task containing the orchestrator's task text and the override reason.
- **FR-010**: When an orchestrator run itself fails or times out, the pipeline MUST NOT start another triage run and MUST create a human task describing the orchestrator failure.
- **FR-011**: An orchestrator "needs human" decision MUST produce a human task through the existing mechanism, with no ticket transition (the ticket already sits in the failure status).

**Automatic handoff context**

- **FR-012**: The system MUST inject a handoff section into the assembled prompt of any run whose trigger carries a handoff source, without modifying the agent's stored instruction: for triage runs — the failing run's report summary, failed/warning checks, artifacts, the worker-agent roster (name + description), the cycle count against the maximum, and the decision protocol; for rework runs — the orchestrator's task, the failing run's summary and failed checks, branch/PR artifacts, and explicit fix-of-existing-work framing; for human-resume runs — the human task's title and details and the operator's answer.
- **FR-013**: Handoff assembly MUST be best-effort and size-bounded (missing source data degrades the section, never fails the run) and MUST read only from the system's own run history.
- **FR-014**: Rework and human-resume runs MUST be treated as continuations for workspace preparation (reuse the existing branch where applicable), and the legacy mechanism that appended the human answer to the instruction text MUST be replaced by the handoff section.

**Human Queue agent picker**

- **FR-015**: The human-task resolve operation MUST accept an optional target agent; when present, the resumed run is created for that agent (validated: exists, enabled, same workspace — otherwise the request is rejected and nothing changes) with the executor profile of the chosen agent; when absent, current same-agent behavior is preserved. Attempt numbering restarts for a newly chosen agent.
- **FR-016**: The resumed run's trigger MUST reference the human task and the parked run so the handoff section can render the question and answer.
- **FR-017**: The Human Queue UI MUST offer an agent selector on blocking-task resume, listing the workspace's enabled agents including the orchestrator, with the orchestrator preselected (original agent when the orchestrator is disabled), and queue items MUST expose the workspace reference the selector needs.
- **FR-025** *(answer-triage delta)*: When the EFFECTIVE resume target (explicit selection, else the parked run's own agent) is the orchestrator, the resume MUST create an `answer-triage` run instead of a `human-resume` run: trigger source `answer-triage`, carrying `human_task_id`, `resolution`, and a `failing_run_id` (the parked run; for a parked orchestrator run, the failing-run reference forwarded from its own trigger, falling back to the parked run id). Its handoff MUST render the Q&A, the failure context, the roster, the cycle count, and the decision protocol.
- **FR-026** *(answer-triage delta)*: A routed decision from an `answer-triage` run MUST be exempt from the exhausted-budget override (the human answer grants one extra rework cycle, exactly once — the decision-time check keys off the deciding run's trigger source). The resulting rework run keeps `source='rework'` and counts in the budget; invalid-target overrides still apply; the automatic fail-triage cap (FR-005/006) is unchanged. The deciding human task's id MUST be forwarded into the rework trigger for traceability.

**Orchestrator lifecycle**

- **FR-018**: An orchestrator agent named "brigadir" MUST be created automatically for every workspace: at wizard creation, at configuration-file seeding, and by a startup backfill for pre-existing workspaces (insert-if-absent — never overwriting an existing one). It MUST never be triggered by board-status polling and MUST run on a dedicated low-cost executor profile without a repository workspace.
- **FR-019**: The orchestrator agent MUST NOT be deletable: the API rejects deletion with a conflict error and the UI shows no delete action for it. Its instruction and other settings remain editable per workspace; disabling it is allowed and turns automated triage off.
- **FR-020**: Agents MUST support a description field used as their roster line in the orchestrator's handoff.

**Central default instruction**

- **FR-021**: The platform MUST provide a global settings store with a "General" settings section (API + platform-settings UI tab) holding, initially, one value: the default orchestrator instruction (single text field with save).
- **FR-022**: The default orchestrator instruction MUST be read at workspace-creation time and copied into the seeded agent (falling back to a built-in default when unset); changing it MUST affect only workspaces created afterwards.

**Consistency fixes bundled with the contract change**

- **FR-023**: The trigger-source vocabulary MUST be corrected to the value the resume flow actually writes ("human-resume") and extended with the triage and rework sources; resumed mock-executor runs MUST validate successfully.
- **FR-024**: Jira comment composition MUST support the "routed" outcome (panel entry plus a line naming the target agent and task); the mock executor MUST support a "routed" scenario so the full loop is testable without live agents; run timeline, architecture documentation (§3, §6), and database migrations MUST be updated in the same change.

### Key Entities

- **Orchestrator agent ("brigadir")**: a per-workspace agent marked as orchestrator; never poll-triggered; non-deletable; instruction editable; runs on a dedicated cheap executor profile without a repository checkout.
- **Routing decision**: the orchestrator's report outcome — either "routed" (target agent name + rework task text) or "needs human" (existing human-task payload).
- **Triage run**: an orchestrator run created in-process from a terminally failed worker run; its trigger references the failing run.
- **Answer-triage run** *(delta)*: an orchestrator run created by a human resolving a blocking task with the orchestrator as the (default) resume target; its trigger references the human task and the failing run, and its routed decision is exempt from the exhausted-budget override.
- **Rework run**: a worker-agent run created from a valid routing decision; its trigger references the failing run, the deciding triage run, and carries the task text; counts against the ticket's rework-cycle budget.
- **Handoff section**: the automatically assembled prompt block that carries cross-run context (failure report, roster, task, human answer) to the next run.
- **Rework-cycle budget**: per-ticket count of rework runs against a per-workspace maximum (default 2), enforced deterministically by the pipeline.
- **Global settings entry**: key-value platform-level configuration; first key is the default orchestrator instruction.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A terminally failed worker run on a workspace with an enabled orchestrator produces exactly one triage run, with no operator involvement and no polling delay, and replay of the completion processing never produces a second one.
- **SC-002**: A routed decision produces a rework run whose prompt contains the orchestrator's task and the failing run's report context, with zero changes to any worker agent's stored instruction.
- **SC-003**: No ticket ever exceeds its configured rework-cycle maximum (default 2) through AUTOMATIC triage: the automatic cycle after the last budgeted one always ends in a human task, in 100% of integration scenarios including invalid-target and orchestrator-failure paths. The single exception is deliberate: a human-answered (answer-triage) decision may route one rework run past the cap, and that run still counts toward the budget afterwards.
- **SC-004**: An operator resolving a blocked ticket can select any enabled agent of the workspace and have it take over in one submit. Choosing a worker: that agent's run prompt contains the question and the answer verbatim. Choosing the orchestrator (the default): the answer-triage run's prompt contains the question and the answer verbatim, and the human's decision reaches the eventual rework worker via the orchestrator's task.
- **SC-005**: Every workspace — newly created or pre-existing at upgrade — has a "brigadir" orchestrator agent; deletion attempts fail while instruction edits succeed.
- **SC-006**: Changing the default orchestrator instruction in General settings changes the instruction of orchestrators in workspaces created afterwards, and changes nothing in existing workspaces.
- **SC-007**: The full fail → triage → route → rework → success loop completes end-to-end under the mock executor in integration tests, with the ticket's Jira status and comments reflecting each step.

## Assumptions

- "Terminally failed" means run statuses failed and timed_out; cancelled and superseded runs do not trigger triage (they reflect operator intent, not agent failure).
- The rework-cycle budget is per ticket (not per agent pair) and counts rework-sourced runs regardless of target agent; the maximum lives in workspace settings with a system default of 2.
- The orchestrator decides from the handoff context only (no repository checkout); its executor profile uses the cheapest suitable model with a short turn limit, and its runs count in run history like any other run.
- The orchestrator's own success/failure status mappings are inert placeholders because the ticket already sits in the worker's failure status during triage; board workflows need no new statuses.
- Human tasks created by triage-limit, invalid-target override, and orchestrator-failure paths are non-blocking (the failed run is already terminal; there is nothing to park); they surface in the existing Human Queue.
- Disabling the orchestrator agent is the supported way to turn automated triage off per workspace; a workspace-level toggle beyond that is out of scope.
- The default-instruction setting affects seeding only; propagating default changes to existing orchestrators is intentionally out of scope for this feature.
- Existing behavior preserved: worker failure still transitions the ticket to the agent's failure status and posts the failure comment before triage begins, so the board remains truthful if triage is skipped or the orchestrator is disabled.
- The pre-existing trigger-source vocabulary mismatch ("human_resume" vs "human-resume") is fixed here because this feature extends the same vocabulary; no separate migration of stored historical trigger events is needed (they are display/validation data, not routing keys).

# Feature Specification: Callback Channel & Reports

**Feature Branch**: `004-callback-channel-reports`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "Feature 004: callback channel & reports — the agent's voice becomes MCP tools instead of stdout."

## Overview *(context, not a template section — kept because this is an internal infra feature)*

Until now a coding agent's only way to "speak" to the orchestrator was the final structured blob it printed to stdout (the iteration-3 `--json-schema` path). This feature gives the agent a **live, in-session voice**: three callback tools — report progress, ask a human, complete the task — delivered as MCP tools that reach an authenticated HTTP API. The agent reports as it works, escalates blockers mid-run, and finalizes with a structured report; the orchestrator turns those reports into Jira transitions, comments, checklists, and human-queue tasks. A human answering a blocking question resumes the work as a fresh attempt. The stdout channel is demoted to a fail-closed safety net so exactly one live completion channel exists.

The "users" of this feature are three actors: the **agent** (a machine actor that calls the tools), the **human operator** (who answers escalations and reviews PRs), and the **orchestrator** (the system that enforces the contract). Success is described from their perspective, not in framework terms.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent finishes work and the orchestrator finalizes the run (Priority: P1)

An agent working on a Jira ticket completes its task and calls `complete_task` exactly once with a structured report (outcome + summary + per-check statuses + optional artifacts). The orchestrator validates the report, persists it, updates the run and its checklist, and drives the Jira ticket to the agent's success or failure status. This is the **only normal exit** of a run.

**Why this priority**: This is the load-bearing contract of the whole feature. Without a working authenticated completion channel and its fail-closed guarantee, no run can end correctly and every downstream story is moot.

**Independent Test**: Drive a run with the fake CLI (or mock executor) that calls the real callback API with its run token and submits a schema-valid report; assert the run reaches `succeeded`/`failed` per outcome, the checklist rows are stored, and the ticket transitioned. Separately, drive a run that exits calling nothing and assert it is finalized `failed` with a diagnostic (fail-closed).

**Acceptance Scenarios**:

1. **Given** a running agent holding a valid per-run token, **When** it calls `complete_task` with a schema-valid report whose `outcome=success`, **Then** the run becomes `succeeded`, the report and per-check rows are persisted, the ticket transitions to the agent's success status, and the tool call is acknowledged.
2. **Given** an agent submitting a report that violates the schema (e.g. `outcome=needs_human` with no `human_task`), **When** it calls `complete_task`, **Then** the call is rejected with a validation-error list the agent can read and repair, and the run is **not** finalized.
3. **Given** a run already finalized by a first `complete_task`, **When** a second `complete_task` arrives for the same run, **Then** it is rejected as a conflict and the first result stands (idempotent completion).
4. **Given** an agent process that exits without ever calling `complete_task` and without a blocking escalation, **When** the orchestrator observes the process end, **Then** the run is finalized `failed` with a diagnostic (fail-closed, FR-010/FR-011); any report-shaped text the process printed is retained as diagnostic context only and never rescues the run into a non-failed outcome.
5. **Given** any callback request presenting a token minted for a *different* run, an expired token, or a token for a run that is already finalized, **When** it reaches the callback API, **Then** it is rejected as unauthorized and nothing is persisted.

---

### User Story 2 - Agent asks a blocking question; a human answers and work resumes (Priority: P1)

Mid-run, the agent hits ambiguity it cannot resolve and calls `request_human` with `blocking=true`. The run is parked as `awaiting_human`, a human task appears in the queue, and the ticket is moved to its blocked status with a comment carrying the question. The agent exits **without** calling `complete_task` — this is a legitimate exit. A human answers via the API; answering closes the parked run as `superseded` and creates a new attempt of the same agent (in one transaction, respecting the single-active-run guarantee), moving the ticket to the running status. The new attempt receives the human's answer in its context and completes with a report.

**Why this priority**: This is the required end-to-end scenario and the reason the callback channel must be *live* rather than a final blob. It exercises escalation, the parked-run lifecycle, the resume transaction, and completion together.

**Independent Test**: Fake CLI attempt #1 calls `request_human{blocking:true}` then exits; assert a human task is open, the run is `awaiting_human`, and the ticket is blocked. Answer via the resolve API with `action=resume`; assert the old run is `superseded`, a new attempt exists as the single active run, and the ticket is in the running status. Fake CLI attempt #2 reads the answer from its context and calls `complete_task`; assert `succeeded`.

**Acceptance Scenarios**:

1. **Given** a running agent, **When** it calls `request_human` with `blocking=true`, **Then** a human task (`kind`, `title`, `details`, `blocking=true`) is created, the run becomes `awaiting_human`, the ticket transitions to its blocked status with a comment containing the question, the completion marker is written so the agent may exit cleanly, and the tool response tells the agent it may finish now without calling `complete_task`.
2. **Given** an open blocking human task, **When** a human resolves it with `action=resume` and an answer, **Then** in a single transaction the parked run is closed as `superseded` and a new attempt (attempt + 1) of the same agent is created as the only active run, and the ticket transitions to the **running** status — never back through the trigger status.
3. **Given** a resumed attempt, **When** it runs, **Then** its instruction context includes the human's answer, and it can finish normally via `complete_task`.
4. **Given** an open blocking human task, **When** a human resolves it with `action=done_manually` or `action=dismiss`, **Then** the parked run is closed without creating a new attempt and no automated ticket transition is performed for those actions.

---

### User Story 3 - Agent reports progress and raises non-blocking notes without stopping (Priority: P2)

While working, the agent calls `report_progress` at stage boundaries so the run's timeline and progress reflect what it is doing. It can also call `request_human` with `blocking=false` to leave a question or note in the human queue **without** halting — the run continues to completion.

**Why this priority**: Progress visibility and non-blocking escalation make runs observable and let agents surface concerns without derailing delivery, but the run can still succeed without them, so they rank below the completion and resume contracts.

**Independent Test**: Fake CLI emits two `report_progress` calls then completes; assert both land on the run timeline and the run still finalizes. Separately, fake CLI emits `request_human{blocking:false}` then `complete_task`; assert a human task exists and the run reached `succeeded` (the note did not park it).

**Acceptance Scenarios**:

1. **Given** a running agent, **When** it calls `report_progress` with a stage and message, **Then** the event is recorded on the run timeline and reflected as run progress, and the call returns success.
2. **Given** a running agent, **When** it calls `request_human` with `blocking=false`, **Then** a human task is created and the run continues running (not parked), and the agent later finalizes normally with `complete_task`.

---

### User Story 4 - A successful run that opened a pull request queues a human review (Priority: P2)

When an agent configured for `code_delivery=pull_request` finishes successfully and its report declares a pull request, the orchestrator creates a **non-blocking** human task of `kind=review`. Merging the PR remains a human action; the orchestrator never merges.

**Why this priority**: It closes the "feature finishes = merge the PRs" gap and keeps humans in the merge loop, but it is an additive downstream reaction to a successful completion rather than part of the core channel.

**Independent Test**: Fake CLI completes with `outcome=success` and an artifact PR URL under a PR-delivery agent; assert a non-blocking `kind=review` human task is created referencing the PR and that no merge/transition beyond success occurred.

**Acceptance Scenarios**:

1. **Given** an agent whose delivery mode is pull request, **When** its run completes successfully with a report declaring a PR URL, **Then** a non-blocking `kind=review` human task is created carrying the PR reference and the run remains `succeeded`.
2. **Given** the same completion, **When** the review task is created, **Then** the orchestrator performs no merge action.

---

### User Story 5 - Report and escalation texts are scrubbed of secrets before they are stored or shown (Priority: P2)

Any free-text the agent sends — report summary and check reasons, progress messages, human-task titles/details — passes through a secret scrubber that redacts known secret patterns before the text is persisted and before any of it is written to Jira.

**Why this priority**: It is a safety guarantee that must hold everywhere the agent's words leave the run boundary, but it is a filter over the other stories rather than a standalone user journey.

**Independent Test**: Fake CLI submits a report and a human-task detail containing planted secret-shaped strings; assert the persisted rows and the Jira-bound comment contain redactions in place of the secrets and no original secret survives.

**Acceptance Scenarios**:

1. **Given** agent-supplied text containing a recognizable secret pattern, **When** it is submitted via any callback, **Then** the stored copy has the secret redacted.
2. **Given** the same text destined for a Jira comment, **When** the orchestrator writes to Jira, **Then** the written text is the scrubbed copy, never the raw one.

---

### User Story 6 - The agent starts with feature context from sibling tickets (Priority: P3)

The instruction wrapper handed to an agent includes feature context: the ticket's epic and its linked issues with their current statuses, plus branches and PR URLs extracted from previous runs' reports on those linked issues. This lets a downstream agent build on what upstream agents already produced.

**Why this priority**: It measurably improves cross-agent continuity within a feature, but a run is fully functional without it, so it is the lowest-priority slice here.

**Independent Test**: Seed a ticket with an epic and a linked issue that has a prior run whose report declared a branch and PR; trigger a new run and assert the compiled wrapper it receives contains the epic, the linked issue with its status, and the branch/PR extracted from the prior report.

**Acceptance Scenarios**:

1. **Given** a ticket linked to sibling issues under an epic, **When** the wrapper for a new run is compiled, **Then** it lists the epic and each linked issue with its current status.
2. **Given** a linked issue with a previous run whose report declared branch/PR artifacts, **When** the wrapper is compiled, **Then** those branches/PRs appear in the feature-context section.

---

### Edge Cases

- **Token expiry mid-run**: a run that runs past its token's lifetime can no longer authenticate callbacks; such a late call is rejected as unauthorized (token TTL is tied to the run timeout plus a grace window). The run is not silently kept alive by callbacks.
- **Late callback after cancel/finalize**: a `complete_task` (or any callback) arriving after the run was cancelled, timed out, or superseded is rejected — no resurrection of a closed run.
- **Blocking escalation followed by a completion attempt**: if an agent both parks the run via blocking `request_human` and then still tries `complete_task`, the completion is rejected because the run is no longer in an acceptable state.
- **Stop-hook with no marker**: when the agent tries to end its session without having written the completion marker (no `complete_task`, no blocking `request_human`), session end is blocked with a reminder to call `complete_task` or `request_human`; the block is bounded (it will not loop forever) so a stuck agent still terminates and is caught by the fail-closed net.
- **Resume while the ticket is not in the parked state anymore** (a human moved it in Jira): resolution must not create a conflicting second active run; the single-active-run guarantee is the backstop.
- **Non-blocking human task on an already-completed run**: creating a review task after success must not reopen or re-transition the run.
- **Transient network blips between the tool and the API**: a callback must not be lost to a single blip; delivery tolerates brief retriable failures.

## Requirements *(mandatory)*

### Functional Requirements

**Callback channel & authentication**

- **FR-001**: The system MUST expose three callback operations to a running agent — report progress, request human, and complete task — and these MUST be the only sanctioned way for an agent to communicate with the orchestrator.
- **FR-002**: Every callback MUST be authenticated by a per-run credential minted at the run's spawn, scoped to that single run, and expiring at the run's timeout plus a grace window.
- **FR-003**: The callback API MUST reject any request whose credential does not match the run identified in the request, is expired, or targets a run that is not in an acceptable state (i.e. not currently `running` or `awaiting_human`).
- **FR-004**: The per-run credential MUST NOT appear in the agent process's command-line arguments nor be exposed to the agent beyond what the tool-serving process itself requires to make the call.
- **FR-005**: The three tools MUST be delivered to the agent such that the agent invokes them by name and the credential is injected into the tool-serving process's environment, never placed on disk in cleartext argv or the agent's own visible environment.
- **FR-006**: Callback delivery MUST tolerate transient network failures with bounded retries so a single blip does not drop a report; tool errors that remain MUST be surfaced back to the agent so it can retry.

**Completion contract**

- **FR-007**: `complete_task` with a schema-valid report MUST be the single normal completion of a run: it MUST persist the report and per-check rows, set the run outcome, and drive the resulting Jira transition/comment via the system's write path.
- **FR-008**: A `complete_task` whose report fails validation MUST be rejected with a machine-readable list of validation errors and MUST NOT finalize the run, allowing the agent to repair and resubmit.
- **FR-009**: Completion MUST be idempotent per run: the first valid completion wins; any later completion for the same run is rejected as a conflict.
- **FR-010**: A run whose agent process ends without any completion callback and without a blocking escalation MUST be finalized `failed` with a diagnostic (fail-closed), mirroring the iteration-3 fail-closed rule.
- **FR-011**: The iteration-3 stdout structured-report channel MUST be RETIRED for callback-wired runs: when the MCP toolset is delivered to a run, the CLI-level structured-output constraint is no longer applied to the session, and any report-shaped text the process emits is captured as diagnostic context only — it MUST NOT finalize the run and MUST NOT rescue an FR-010 no-callback failure. Exactly one completion channel exists per run. (Rationale: a silent rescue path would mask agents that never learned to call `complete_task` and would let a broken callback channel — which also breaks `request_human` — degrade silently instead of failing loudly. Executors that do not use the callback channel, e.g. mock in tests, keep their existing in-process report path unchanged.)

**Human escalation & resume**

- **FR-012**: A blocking `request_human` MUST create a human task, park the run as `awaiting_human`, transition the ticket to its blocked status with a comment carrying the question, and return guidance telling the agent it may finish without calling `complete_task`.
- **FR-013**: Both `complete_task` and a blocking `request_human` MUST write the session-completion marker so the agent's session is allowed to end.
- **FR-014**: A non-blocking `request_human` MUST create a human task while leaving the run running to normal completion.
- **FR-015**: The system MUST record human tasks with their kind (question / blocker / review) and blocking flag, associated to the run and ticket.
- **FR-016**: Resolving a blocking human task with a resume action MUST, in a single transaction, close the parked run as `superseded` and create a new attempt (attempt + 1) of the same agent as the only active run, honoring the single-active-run guarantee.
- **FR-017**: On resume the ticket MUST transition to the running status and never back through the trigger status, and the run MUST be created before the transition.
- **FR-018**: A resumed attempt's instruction context MUST include the human's answer.
- **FR-019**: Resolving with a "done manually" or "dismiss" action MUST close the human task and its parked run without creating a new attempt and without the orchestrator transitioning the ticket for the dismiss/manual cases.
- **FR-020**: When creating a human task from a completion report that declares `needs_human`, the system MUST deduplicate per run so a run never has more than one open human task from that path.

**Progress**

- **FR-021**: `report_progress` MUST record a timeline event for the run and update the run's progress indicator, without altering run status.

**Session enforcement (Stop-hook)**

- **FR-022**: The spawned agent session MUST be given a session-end hook that blocks ending the session while the completion marker is absent, reminding the agent to call `complete_task` or `request_human`.
- **FR-023**: The session-end block MUST be bounded so it cannot loop indefinitely; after the bound the session is allowed to end and is caught by the fail-closed rule (FR-010).

**Secret scrubbing**

- **FR-024**: The system MUST scrub known secret patterns from report fields, progress messages, and human-task titles/details before persisting them and before any Jira write; the raw secret MUST never be stored or written outward.

**Pull-request review**

- **FR-025**: A successful run under an agent configured for pull-request delivery whose report declares a pull request MUST produce a non-blocking `kind=review` human task carrying the PR reference; the orchestrator MUST NOT merge.

**Wrapper feature context**

- **FR-026**: The instruction wrapper MUST include feature context: the ticket's epic and its linked issues with current statuses, plus branches and PR URLs extracted from previous runs' reports on those linked issues.

### Key Entities *(include if feature involves data)*

- **Per-run credential**: a short-lived authorization bound to one run, carrying the run id, workspace, and ticket key and expiring at the run timeout plus grace; the agent never sees it.
- **Callback event**: a progress / human-request / completion message from the agent, recorded on the run's timeline.
- **Agent report**: the structured final result — outcome, human-readable summary, a list of named checks with pass/fail/skip/warn statuses and reasons, and optional artifacts (branch, PR URL, commits, files changed). Its schema is the single source of truth for the completion tool (and remains shared with the non-callback executors' in-process report path).
- **Human task**: a queued item for a person — kind (question / blocker / review), title, details, blocking flag, status (open / resolved / dismissed), the human's resolution, and its run/ticket association.
- **Completion marker**: a per-run signal, written by a legitimate terminal callback (completion or blocking escalation), that authorizes the agent session to end.
- **Wrapper feature context**: the compiled block handed to an agent describing the epic and linked issues with statuses and prior-run branches/PRs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of runs end in exactly one of the defined terminal states (`succeeded`, `failed`, `awaiting_human`→resumed/closed, `cancelled`, `timed_out`, `superseded`); no run ends via an uncontrolled stdout blob and no run has two competing completion sources applied.
- **SC-002**: 100% of agent processes that end without a sanctioned callback are finalized `failed` with a diagnostic (no silent success, no hang).
- **SC-003**: A blocking question answered by a human results in a new attempt that reaches completion, with at most one active run for the (ticket, agent) pair at every point during the transition — verified by the required end-to-end scenario.
- **SC-004**: Callbacks presenting a mismatched, expired, or finalized-run credential are rejected 100% of the time and never mutate stored state.
- **SC-005**: No known-pattern secret planted in any agent-supplied text appears in stored records or in text written to Jira (0 leaks across the scrubber test corpus).
- **SC-006**: Every run has an ordered, inspectable timeline of its progress and escalation events reconstructable after the fact.
- **SC-007**: A duplicate/late completion for an already-finalized run is rejected as a conflict 100% of the time.
- **SC-008**: For an agent configured for pull-request delivery, a successful PR-declaring run produces exactly one non-blocking review task and zero automated merges.
- **SC-009**: The whole feature is exercised by integration tests using the existing testcontainers + fake-CLI pattern with no real agent CLI or subscription, including the required blocking-question → resume → completion end-to-end scenario, and the mock executor can also drive the callback flows.

## Assumptions

- **Canonical protocol is fixed**: The callback flows, completion contract, report schema, and wrapper shape are taken as-is from `docs/architecture.md` §5–§7 and `docs/spec.md` §1.1–§1.4 (aligned across docs after adversarial review); this spec encodes them and does not re-invent them.
- **Credential form**: The per-run credential is a signed short-lived token carrying `{run id, workspace, ticket key, expiry}`, expiry = run start + timeout + a small grace window; the exact grace duration is an implementation detail chosen in planning (a few minutes is assumed).
- **Channel retirement (amended 2026-07-11, checkpoint review)**: For callback-wired runs the iteration-3 `--json-schema` structured-output constraint is NOT applied (it would force a second, potentially divergent report alongside `complete_task`); a process that ends silently is finalized `failed` per FR-010 with its final output retained as diagnostics only. The structured-output extraction code remains in the tree for executors/runs without the callback channel, but exactly one completion channel is live for any given run. The minimal Phase-0 `/complete` endpoint is superseded by the full callback API.
- **Secret patterns**: The scrubber reuses/extends the known secret-pattern set already used for environment sanitization in iteration 3 (regex plus entropy heuristics); exhaustive coverage of all possible secrets is not claimed — known patterns are.
- **Stop-hook in print mode**: Session-end (Stop) hook behavior under the CLI's non-interactive print mode is to be validated during planning; the requirement (block on missing marker, bounded) stands regardless of the exact hook mechanism the CLI exposes.
- **Delivery bindings out of scope here**: Only the stdio tool binding for the local CLI executor is in scope; the in-process SDK and HTTP/remote bindings named in architecture §5 are deferred with the non-`claude_cli` executors.
- **Test realism**: Integration tests hit the real callback HTTP API with the run token the fake CLI receives; the broker and datastore are real (testcontainers), per the constitution — no mocked broker.

## Out of Scope

- Tasks UI / human-queue UI (iteration 6) — answering tasks via API/curl is acceptable this iteration.
- Slack or other notifications for human tasks (iteration 8+).
- Reusing an agent session via `claude --resume` — resume here is always a **new attempt** process (iteration 8+).
- Sandboxing / isolation hardening beyond the existing env-sanitization + worktree model.
- `anthropic_api` and `deepseek_api` executors and their in-process/HTTP tool bindings.

# Feature Specification: Workspace Setup by the Orchestrator ("Generate agents") + Read-Only Jira Tools

**Feature Branch**: `011-workspace-setup`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Workspace setup by the orchestrator ('Generate agents'): bootstrap a new workspace's agent team via a brigadir setup run, plus read-only Jira callback tools for all agents. New workspaces are created paused; a 'Generate agents' button (offered while the workspace has no agents besides the orchestrator) starts a ticketless setup run of the seeded 'brigadir' orchestrator, which studies the Jira project through read-only callback tools and returns a one-shot structured team proposal; the pipeline validates the proposal atomically, creates the agents enabled, and files a review human task; the human reviews the team in the existing agents UI and starts the workspace with the single existing switch. Read-only Jira tools are available to ALL agent runs so worker agents can fetch ticket descriptions and comments mid-run."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One action turns an empty workspace into a reviewable agent team (Priority: P1)

A user creates a workspace through the wizard (Jira connection, board, repositories) — as today, the orchestrator agent "brigadir" is seeded automatically, and — new — the workspace comes into existence paused. Instead of hand-writing every worker agent, the user presses a single **Generate agents** action on the workspace page. The system starts a setup run of the orchestrator: the orchestrator studies the Jira project (board type, workflow statuses, issue types, actual tickets with their descriptions, comments, and links) and returns one structured **team proposal** — a list of worker agents, each with a name, a description, an instruction, a trigger status, running/success/failure statuses, and an executor profile. The system validates the entire proposal, creates all the agents, and files a review task in the Human Queue: "team assembled — review the workspace". The user reviews and edits the agents in the existing agents UI, resolves the review task, and starts the workspace with the existing single start switch. Only then does the pipeline begin picking up tickets.

**Why this priority**: This is the core value of the feature — assembling a workspace team today means writing every agent by hand, which is the single largest setup cost of adopting the product for a new project. One reviewed proposal replaces that entire manual step.

**Independent Test**: Using the mock executor with a team-proposal scenario, create a workspace, trigger Generate agents, and verify: exactly one setup run is created for the orchestrator; on completion the proposed agents exist enabled in the workspace, a review task is open in the Human Queue, and the workspace is still paused. Resolve the task, start the workspace, and verify polling picks up tickets only after the start.

**Acceptance Scenarios**:

1. **Given** a workspace is created through the wizard or the configuration seed, **When** creation completes, **Then** the workspace exists paused (excluded from polling), with the orchestrator agent seeded as today, and no worker runs ever start before the user starts the workspace.
2. **Given** a workspace whose only agent is the orchestrator and which has no active setup run, **When** the user opens the workspace page, **Then** a Generate agents action is offered; pressing it starts exactly one setup run of the orchestrator agent and does not change the workspace's paused state.
3. **Given** a setup run in progress, **When** its prompt is assembled, **Then** it contains an automatically injected handoff with a compact project digest (board type, workflow statuses, issue types, configured repositories, available enabled executor profiles), the setup decision protocol, and the team-proposal contract — with no setup-specific text in the orchestrator's stored instruction.
4. **Given** a setup run that completes with a valid team proposal, **When** the pipeline processes it, **Then** all proposed agents are created enabled in one transaction through the same validation path as manual agent creation, a non-blocking review human task is created for the workspace, and the workspace remains paused.
5. **Given** the created team and the open review task, **When** the user edits agents in the existing agents UI, resolves the review task, and flips the existing workspace start switch, **Then** the pipeline begins processing board tickets with the generated team — and nothing ran before the switch.

---

### User Story 2 - Any agent run can read Jira mid-run (Priority: P2)

A worker agent implementing a ticket needs more than the prompt snapshot: a late comment from a teammate, the full description of a linked ticket, the current sprint contents. During any run — worker or orchestrator — the agent can call read-only Jira tools over the existing callback channel: fetch the project/board overview, search tickets within the workspace scope, and read a single ticket with its description, comments, and links. Reads are served by the system with the workspace's own Jira access; the agent never sees Jira credentials, and the tools cannot write anything.

**Why this priority**: The setup run's project study is the immediate consumer, but the standing gap is general: today an agent works from a one-shot prompt snapshot and goes blind the moment it needs one more comment. This unlocks mid-run context for every agent while keeping the write monopoly intact.

**Independent Test**: In an integration run against the mock Jira layer, call each read tool with a valid run token and verify correct workspace-scoped data is returned; verify a request for a ticket outside the run's workspace is rejected; verify the toolset exposes no write operation.

**Acceptance Scenarios**:

1. **Given** any active run (worker or orchestrator, ticketed or setup), **When** the agent calls a read-only Jira tool with the run's callback token, **Then** the system serves the read using the workspace's Jira access and the agent receives the data without ever holding Jira credentials.
2. **Given** the read toolset, **When** its surface is enumerated, **Then** it offers exactly: project/board overview (board type, workflow statuses, issue types, active sprint), ticket search within the workspace scope, and single-ticket read (description, comments, links) — and no operation that writes to Jira in any form.
3. **Given** a read tool call referencing a ticket or project outside the run's workspace scope, **When** it is processed, **Then** it is rejected and nothing is returned from outside the scope.
4. **Given** a ticket with a very large description or comment history, **When** it is read through a tool, **Then** the response is size-bounded with an explicit truncation indication rather than unbounded.
5. **Given** an expired or foreign run token, **When** a read tool is called with it, **Then** the call is rejected exactly as existing callback tools reject it.

---

### User Story 3 - Setup runs are guarded: no duplicates, no partial teams, loud failures (Priority: P2)

The generate action is safe to press twice, safe to fail, and never leaves the workspace half-assembled. A second generate request while a setup run is active is rejected. A proposal that fails validation (duplicate or conflicting agent name, a trigger status that does not exist in the board's workflow, an unknown or disabled executor profile) rejects the whole proposal: the setup run fails with the validation errors recorded, a human task describes the failure, and zero agents are created. A setup run that itself fails or times out produces a human task and is never triaged (the orchestrator is never routed by itself). If the orchestrator needs a human decision mid-setup, it asks through the existing human-task mechanics, and resolving that task resumes setup as a fresh setup run carrying the question and answer.

**Why this priority**: Without these guards the P1 flow is unsafe to expose as a one-click button — double-clicks would double teams, and a half-applied proposal would be worse than no proposal.

**Independent Test**: With the mock executor: fire two concurrent generate requests and verify exactly one setup run exists; complete a setup run with an invalid proposal and verify zero agents plus a failure human task; fail a setup run and verify a human task and no triage run; park a setup run on a blocking question, resolve it, and verify a new setup run whose prompt carries the Q&A.

**Acceptance Scenarios**:

1. **Given** an active setup run on a workspace, **When** another generate request arrives (double-click, concurrent API call), **Then** it is rejected and exactly one active setup run exists — enforced at the API level, the queue level, and by a database-level uniqueness guard, since the existing per-ticket guard does not cover ticketless runs.
2. **Given** a completed setup run whose proposal fails validation on any single item, **When** the pipeline processes it, **Then** no agent is created at all, the run is failed with the specific validation errors recorded on its report/timeline, and a human task describing the failure is created.
3. **Given** a setup run that itself fails or times out, **When** the pipeline processes the outcome, **Then** a human task describing the failure is created and no triage run is started.
4. **Given** a setup run parked on a blocking human question, **When** the operator resolves the task with an answer, **Then** a new setup run is created whose prompt carries the original question and the answer, and the answer-triage routing path is not involved (there is no failing worker run to route).
5. **Given** the pipeline's completion processing replayed for the same setup run (drift repair), **When** it runs again, **Then** no duplicate agents and no duplicate review task are created.
6. **Given** a team proposal returned by any run that is not an orchestrator setup run, **When** the pipeline processes it, **Then** it is treated as an invalid outcome (failure), mirroring the existing rule for routing decisions from non-orchestrator agents.

---

### User Story 4 - Ticketless runs are first-class citizens of the existing UI (Priority: P3)

Setup runs have no Jira ticket — a first for the system, where every run and human task so far hangs off a ticket. The Runs tab, the run card, and the Human Queue display setup runs and setup-related human tasks gracefully: labeled as workspace setup instead of a ticket key, with the run timeline, checks, cost, and report rendered as for any run. The generate action reflects the setup run's progress (offered → running → done/failed).

**Why this priority**: Without it the P1 flow works but produces confusing UI artifacts (empty ticket columns, broken links); it polishes rather than enables.

**Independent Test**: Create a setup run via the mock executor and verify the Runs list, the run card, and the Human Queue render it and its human tasks without errors, labeled as workspace setup, with no dead ticket links.

**Acceptance Scenarios**:

1. **Given** a setup run, **When** the Runs tab and run card render it, **Then** no ticket key is shown (a workspace-setup label appears instead), no broken Jira link is offered, and timeline/checks/cost/report render as for any run.
2. **Given** a ticketless human task (review task or setup-failure task), **When** the Human Queue renders it, **Then** the task renders without a ticket reference and resolves through the existing queue flow.
3. **Given** a workspace with an active setup run, **When** the workspace page renders, **Then** the generate action is not offered again and the setup run's status is visible to the user.

---

### Edge Cases

- **Empty or nearly empty Jira project** (no tickets yet, or a Scrum board with no active sprint): the digest and read tools may return little content; the orchestrator can still propose a team from the workflow structure alone — or ask a human via the existing blocking-question mechanics. An empty *proposal* (zero agents) is invalid.
- **Proposal name collisions**: a proposed agent named like the orchestrator ("brigadir"), duplicated within the proposal, or colliding with an already existing agent → whole proposal rejected.
- **Proposal referencing statuses absent from the board workflow** (trigger or target statuses) → whole proposal rejected with the offending items named.
- **Workspace started before the review task is resolved**: allowed — the review task is non-blocking and the start switch is the user's prerogative; the task simply stays open until resolved.
- **All worker agents deleted later**: the generate action reappears (the offer condition is "no non-orchestrator agents and no active setup run"); regeneration onto a *populated* team remains out of scope for v1.
- **Orchestrator disabled by the user**: the generate action is unavailable (it requires an enabled orchestrator), mirroring how disabling the orchestrator switches off triage.
- **Setup run cancelled by the operator**: existing run-cancel semantics apply; the generate action becomes available again once no setup run is active.
- **Read-tool flood** (an agent looping over search calls): reads go through the workspace's existing rate-limited Jira access; the run's existing turn/timeout limits bound the loop. No separate quota in v1.
- **Config-file-seeded workspaces that already define worker agents**: created paused like all new workspaces; the generate action never appears because worker agents exist from the seed.
- **Jira unreachable during a setup run**: read tools return errors to the agent; the digest degrades best-effort at prompt assembly (missing data never fails run creation); the orchestrator may still propose from what it has or ask a human.

## Requirements *(mandatory)*

### Functional Requirements

**Workspace lifecycle & entry point**

- **FR-001**: A newly created workspace (wizard or configuration seed) MUST come into existence paused — excluded from board polling exactly like a workspace paused today — while workspace creation is otherwise unchanged (orchestrator seeding included). Pre-existing workspaces are unaffected. Starting the workspace remains the existing single switch; no new enable ceremony is introduced.
- **FR-002**: The workspace page MUST offer a "Generate agents" action exactly when the workspace has zero non-orchestrator agents, an enabled orchestrator agent, and no active setup run; the backing operation MUST reject requests violating any of those conditions. Re-generating onto a workspace that already has worker agents is out of scope for v1.
- **FR-003**: The generate action MUST start a setup run of the workspace's orchestrator agent under a new dedicated trigger source (workspace-setup), on the orchestrator's existing executor profile, without a repository checkout, and MUST NOT modify the workspace's paused/started state.
- **FR-004**: At most one active setup run may exist per workspace, enforced in depth: request-level validation, queue-level deduplication, and a database-level uniqueness guard equivalent to the existing per-ticket active-run guard (which does not cover ticketless runs).

**Ticketless runs and human tasks**

- **FR-005**: Runs and human tasks MUST support having no ticket: the ticket reference becomes optional (schema migration; architecture document §3 updated in the same change per constitution). Setup runs and the human tasks they produce (review, failure, blocking questions) carry no ticket.
- **FR-006**: Setup runs MUST be exempt from ticket-centric pipeline behavior: no Jira status transitions, no Jira comments, no participation in the rework-cycle budget, and no triage on failure (orchestrator failure semantics: a failed or timed-out setup run produces a human task describing the failure and is never routed).
- **FR-007**: Every user-facing surface that renders a run's or human task's ticket (runs list, run card, Human Queue, any deep links) MUST tolerate ticketless entries, labeling them as workspace setup and offering no broken ticket links.

**Read-only Jira callback tools (all runs)**

- **FR-008**: The callback channel MUST offer read-only Jira tools to EVERY agent run — worker and orchestrator, ticketed and setup — authenticated by the run's existing per-run callback credentials and scoped to the run's workspace.
- **FR-009**: The read toolset MUST provide: (a) project/board overview — board type, workflow statuses, issue types, active sprint if any; (b) ticket search within the workspace's board scope; (c) single-ticket read with description, comments, and links. All reads are served by the system through the workspace's existing rate-limited Jira access; agents MUST never receive Jira credentials.
- **FR-010**: The read toolset MUST NOT expose any operation that writes to Jira, and requests targeting tickets or projects outside the run's workspace scope MUST be rejected. The system-only-writes invariant (Principle III) is untouched.
- **FR-011**: Read-tool responses MUST be size-bounded with explicit truncation indication, so unbounded Jira content cannot flood a run.

**Setup handoff**

- **FR-012**: The setup run's prompt MUST receive an automatically assembled handoff section — a compact project digest (board type, workflow statuses, issue types, configured repositories, available enabled executor profiles), the setup decision protocol, and the team-proposal contract — injected without modifying the orchestrator's stored instruction, assembled best-effort and size-bounded (missing source data degrades the section, never fails the run).

**Team proposal contract & processing**

- **FR-013**: The run report contract MUST support a new outcome carrying a workspace-setup team proposal: a list of at least one proposed agent, each with name, description, instruction, trigger status, running/success/failure statuses, and a reference to an executor profile. The outcome without its payload — or with an empty agent list — MUST be rejected as invalid, mirroring the existing needs-human and routed payload rules.
- **FR-014**: Only an orchestrator's setup run may return a team proposal: the outcome from any other run MUST be treated as a failure with the invalid outcome noted, mirroring the existing rule for routing decisions.
- **FR-015**: The pipeline MUST validate the entire proposal atomically before applying anything: agent names unique within the proposal and against all existing agents of the workspace (the orchestrator included); every referenced trigger/running/success/failure status present in the board's workflow; every referenced executor profile existing and enabled; no proposed agent claiming orchestrator standing; all text fields within the same size limits as manual agent creation. Any single violation rejects the whole proposal.
- **FR-016**: A valid proposal MUST be applied in one transaction: all agents created enabled through the same validation path as manual agent creation, and one non-blocking review human task ("team assembled — review the workspace") created for the workspace. A partially applied team MUST be impossible.
- **FR-017**: An invalid proposal MUST fail the setup run with the specific validation errors recorded on the run's report/timeline and surfaced in a human task describing the failure; no agents are created.
- **FR-018**: Proposal text fields MUST pass the same secret scrubbing as all other report fields before persistence.
- **FR-019**: Replayed completion processing for the same setup run MUST NOT create duplicate agents or duplicate review tasks (idempotent apply, recorded in the completion marker as for triage decisions).

**Setup-run human interaction**

- **FR-020**: A setup run MAY ask for human input through the existing blocking-question mechanics; the resulting ticketless human task parks the run as usual, and resolving it with resume MUST produce a new setup run whose handoff carries the original question and the operator's answer. The answer-triage routing path MUST NOT be used for parked setup runs (there is no failing worker run to route).

**Testing & documentation**

- **FR-021**: The mock executor MUST support a team-proposal scenario so the full generate → study → propose → apply → review loop is coverable by integration tests against real Postgres/Redis without live agents; read-only tools MUST be testable against the existing mock Jira layer. Schema and report-contract documentation (architecture §3, §6) and committed migrations MUST be updated in the same change.

### Key Entities

- **Setup run**: a ticketless run of the workspace's orchestrator agent, triggered explicitly by the generate action; unique per workspace while active; exempt from ticket transitions, Jira comments, rework budget, and triage.
- **Team proposal**: the setup run's one-shot structured deliverable — a list of proposed worker agents (name, description, instruction, trigger status, running/success/failure statuses, executor profile reference); validated atomically, applied transactionally.
- **Project digest**: the compact, system-assembled summary of the Jira project (board type, statuses, issue types, repositories, executor profiles) injected into the setup run's handoff.
- **Read-only Jira toolset**: callback tools available to every run — project/board overview, scoped ticket search, single-ticket read — served by the system, credential-free for the agent, write-free by construction.
- **Review task**: the non-blocking human task closing the setup flow ("team assembled — review the workspace"); ticketless; resolving it is part of the human gate together with the existing workspace start switch.
- **Paused-by-default workspace**: a newly created workspace excluded from polling until the user flips the existing start switch — the single gate in front of the generated (already enabled) team.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from a freshly created workspace to a complete, reviewable agent team with a single action plus one review — writing zero agent definitions by hand; the generated agents are immediately editable in the existing agents UI.
- **SC-002**: Zero worker runs occur on a workspace between its creation and the user's start action, in 100% of integration scenarios — including workspaces holding a fully generated, enabled team.
- **SC-003**: Concurrent or repeated generate requests never yield more than one active setup run per workspace, in 100% of integration race tests.
- **SC-004**: A proposal failing any validation rule creates exactly zero agents (no partial teams) and always surfaces the failure as a human task, in 100% of integration scenarios.
- **SC-005**: Any agent run can retrieve a ticket's description, comments, and the board overview mid-run through the callback channel without holding Jira credentials; every request outside the run's workspace scope is rejected, in 100% of integration scenarios.
- **SC-006**: All run and human-task views render ticketless setup entries without errors or broken links, labeled as workspace setup.
- **SC-007**: Replayed completion processing of a setup run produces no duplicate agents and no duplicate review tasks.
- **SC-008**: The full loop — generate, study via read tools, propose, apply, review task — completes end-to-end under the mock executor in integration tests, with the workspace still paused at the end.

## Assumptions

- The orchestrator agent ("brigadir", feature 010) exists, is seeded on every workspace, is non-deletable, and runs on a cheap executor profile without a repository checkout; this feature reuses it as-is, adding only the new trigger source and handoff variant.
- Generated agents are created **enabled**; the single gate before anything runs is the workspace's paused state ("agents active, workspace paused" — user decision). No per-agent enabling ceremony is added.
- Whether the UI derives extra display states for the workspace list (e.g. "Setting up", "Ready for review") from the paused flag plus an active setup run / open review task is a design point deferred to planning; any solution must be derivable from existing data without new persisted state.
- The review task is non-blocking (there is no parked run behind it once setup completed), and resolving it is decoupled from the start switch: the user may start the workspace first and resolve later.
- Setup runs and read tools share the workspace's existing Jira rate budget; no separate quota is introduced in v1.
- Regeneration of an existing team, and orchestrator-driven edits to workspace settings (e.g. scope query), are out of scope for v1 — the proposal creates agents only.
- The existing config-file seeding path keeps working; config-seeded workspaces are also created paused, and their pre-defined agents simply suppress the generate offer.
- Historical data needs no backfill: existing runs and human tasks keep their tickets; only new setup entries use the ticketless form.

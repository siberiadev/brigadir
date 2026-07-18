# Feature Specification: Per-Ticket Repository Scoping via Jira Components

**Feature Branch**: `claude/jira-components-repo-scoping-fe5fca` (feature directory `020-jira-components-repo-scoping`)

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: per-ticket repository scoping via Jira Components — narrow each run's repository set to what the ticket actually touches, fail closed to the human queue when the scope cannot be determined. Full design brief (settled decisions D1–D5, precedence rules, implementation pointers) preserved verbatim in [design-brief.md](design-brief.md).

## Overview

Feature 019 gave a run multiple repositories, but the set is static — a property of the agent. An agent configured for five repositories provisions all five on every ticket, even when the ticket touches one. This feature makes the ticket's Jira **Components** field narrow the set per run: components that name repositories select them, the result is intersected with the agent's configured scope, and only that subset is provisioned. When the scope cannot be determined and the workspace has opted in, the run parks to the human queue with a question that tells the operator exactly what to fix. Components are used (not Labels) because they are a per-project controlled vocabulary — a picker, not free text — so a typo cannot silently drop a repository from scope.

Five design decisions are settled and MUST NOT be re-litigated: **D1** intersection-not-replacement, **D2** fail-closed parking with three distinct question texts (with **D2a** single-repository skip and **D2b** per-workspace opt-in flag, default off), **D3** ticket-derived names filter silently and never error, **D4** mid-run self-clone escape hatch for ordinary runs, **D5** setup runs unaffected. See [design-brief.md](design-brief.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Runs provision only the repositories the ticket names (Priority: P1)

A team member files a ticket and sets its Components to the repository (or repositories) the work touches — the team already names components after repositories. When an agent picks up the ticket in a workspace with scoping enabled, the run provisions only the repositories that both the ticket's components and the agent's configured scope agree on, instead of everything the agent could ever work in. Components that don't correspond to a repository ("Design", "QA") are ignored without complaint; components naming repositories outside the agent's scope never widen the run.

**Why this priority**: This is the entire point of the feature — smaller, faster, more focused runs. Every other story exists to make this narrowing safe to roll out.

**Independent Test**: In a scoping-enabled workspace, give an agent a multi-repository scope, file a ticket whose components name a strict subset of that scope, trigger a run, and verify only that subset is provisioned and worked in.

**Acceptance Scenarios**:

1. **Given** a scoping-enabled workspace where an agent's scope covers repositories A, B, and C, **When** a run starts for a ticket whose components name only A, **Then** the run provisions and mounts only repository A.
2. **Given** the same agent, **When** a run starts for a ticket whose components are "A" and "Design" (no repository named "Design" exists), **Then** "Design" is silently ignored and the run provisions only repository A — the run does not fail or park.
3. **Given** an agent whose scope covers only repositories A and B, **When** a run starts for a ticket whose components name A and D (D exists in the workspace but is outside the agent's scope), **Then** the run provisions only A — components never add a repository beyond the agent's configured scope.
4. **Given** an agent with no explicit repository scope in a multi-repository workspace, **When** a run starts for a ticket whose components name one workspace repository, **Then** the run provisions only that repository (the base set for an unscoped agent is all workspace repositories, and components narrow it the same way).

---

### User Story 2 - Undeterminable scope parks the run with an actionable question (Priority: P2)

When scoping is enabled and the system cannot determine which repositories a ticket needs, it does not guess and it does not fall back to provisioning everything — it parks the run into the existing human-task queue with a question whose text identifies which of three distinct problems occurred, so the operator knows what to fix without opening logs: (1) the ticket has no components — ask the reporter to set them; (2) components exist but none names a repository — ask for the repository component to be added; (3) the ticket's repositories and the agent's scope don't overlap — a routing problem, check which agent should own this ticket. Resolving the task follows the existing park→resolve loop: a fresh run starts, re-reads the ticket, and scopes correctly with the newly set components.

**Why this priority**: Fail-closed is what makes narrowing trustworthy. Without it, an ambiguous ticket silently gets the wrong (or the full) repository set, and case 3 would hand the ticket to a wrongly-routed agent.

**Independent Test**: Enable scoping in a workspace with a multi-repository agent; trigger runs for tickets in each of the three conditions and verify each parks with its own distinct question text; set components on the ticket, resolve the task, and verify the successor run provisions the now-determinable subset.

**Acceptance Scenarios**:

1. **Given** a scoping-enabled workspace and an effective base set of two or more repositories, **When** a run starts for a ticket with no components at all, **Then** the run parks as a blocking human task whose question asks that Components be set on the ticket so the agent knows which repositories to work in.
2. **Given** the same setup, **When** a run starts for a ticket whose components exist but none matches any workspace repository (e.g. only "Design"), **Then** the run parks with a question stating that none of the ticket's components map to a repository and asking for the repository component to be added.
3. **Given** the same setup, **When** a run starts for a ticket whose components name workspace repositories that are all outside the agent's configured scope, **Then** the run parks with a question stating the ticket targets repositories this agent is not configured for and asking the operator to check routing or the agent's scope.
4. **Given** a run parked under case 1, **When** a human sets the ticket's Components to a repository name and resolves the task, **Then** a fresh run starts for the ticket, re-reads its components, and provisions the named repository.
5. **Given** the three question texts, **When** an operator views the human-task queue, **Then** each parked scoping task is distinguishable from the others by its text alone.

---

### User Story 3 - Per-workspace opt-in with exact status-quo behaviour when off (Priority: P2)

An administrator enables ticket scoping per workspace. The flag defaults to off, and while it is off, behaviour is identical to today in every case: components are ignored entirely (no narrowing, no parking), tickets without components run as before, deprecated single-repository agents run as before, repo-less and setup runs are untouched. This lets the team enable one board, watch the human-task queue, backfill Components on that board's tickets, and then widen — and turn it back off without a deploy if the queue floods.

**Why this priority**: Today no ticket is required to carry Components. Enabling the gate globally would park nearly every incoming ticket at once and turn the system into a human-task generator. The flag is the rollout-safety mechanism for stories 1 and 2.

**Independent Test**: With the flag off (default), run the full existing behaviour matrix (tickets with/without components, multi- and single-repository agents, deprecated field, repo-less runs, setup runs) and verify no observable difference from today; flip the flag on for one workspace and verify narrowing/parking activates there and nowhere else.

**Acceptance Scenarios**:

1. **Given** a workspace with the flag off (the default), **When** a run starts for a ticket that has components, **Then** the components have no effect: the run provisions the full base set exactly as today.
2. **Given** a workspace with the flag off, **When** a run starts for a ticket with no components, **Then** nothing parks and the run proceeds exactly as today.
3. **Given** two workspaces, one with the flag on and one off, **When** identical tickets run in each, **Then** only the flag-on workspace narrows or parks.
4. **Given** an existing deployment upgraded to this feature with no configuration change, **Then** every workspace behaves exactly as before the upgrade.

---

### User Story 4 - Narrowing never blocks: single-repository skip and mid-run escape hatch (Priority: P3)

Narrowing is a fast path, not a wall. When the effective base set contains exactly one repository — a single-repository workspace, or an agent scoped to one repository — components add no information, so the gate never fires and the run proceeds with that repository regardless of what components say. And when an agent discovers mid-run that it needs a repository outside its provisioned set, it can fetch that repository on demand into a designated working location, the same escape hatch setup runs already have.

**Why this priority**: These are guard-rails against over-blocking. Without the single-repository skip, the gate would generate pure-friction human tasks; without the escape hatch, a slightly-too-narrow scope would strand an otherwise healthy run.

**Independent Test**: With the flag on, run a component-less ticket against a single-repository base set and verify it does not park; in a narrowed run, have the agent fetch an additional repository on demand and verify it becomes available in the designated location.

**Acceptance Scenarios**:

1. **Given** a scoping-enabled workspace whose effective base set for a run is exactly one repository, **When** a run starts for a ticket with no components (or with components matching nothing), **Then** the gate does not fire and the run proceeds with that one repository.
2. **Given** a run narrowed to a subset of repositories, **When** the agent needs a repository outside that subset mid-run, **Then** it can obtain a working copy on demand in the designated auxiliary location without the run failing or parking.
3. **Given** a setup run, **When** it executes in a scoping-enabled workspace, **Then** its behaviour is unchanged from today (its deliberate single-repository scope is preserved and the gate never applies).

---

### User Story 5 - The narrowing decision is visible to operators (Priority: P3)

After a run, an operator can see what the scoping step decided: which ticket components matched repositories, which were ignored as non-repository components, whether the gate fired and under which of the three conditions, and what the final provisioned set was. This makes "scoped to one repository on purpose" distinguishable from "scoping misfired" without reading agent transcripts.

**Why this priority**: Trust in fail-closed automation depends on being able to audit it. Needed for the rollout period especially, but not blocking the narrowing mechanics themselves.

**Independent Test**: Run tickets through matched, partially-matched, and parked paths, then verify an operator can reconstruct each decision (inputs, matches, ignores, outcome) from the run's visible record alone.

**Acceptance Scenarios**:

1. **Given** a completed narrowed run, **When** an operator inspects the run's record, **Then** they can see the ticket's components, which of them selected repositories, which were ignored, and the final provisioned set.
2. **Given** a run parked by the gate, **When** an operator inspects it, **Then** the record shows which of the three park conditions fired.

---

### Edge Cases

- **Component name differs from repository name only by letter case**: the match still succeeds — comparison is case-insensitive on trimmed names (see Assumptions). A case mismatch must not park a run.
- **Several components map to the same repository, or the ticket carries duplicate-equivalent names**: the repository appears once in the provisioned set; duplicates are harmless.
- **Run has no associated ticket** (contexts where no ticket exists to carry components): scoping does not apply; the run keeps today's full base-set behaviour. Parking would be nonsensical — there is no ticket for a human to fix.
- **Agent configured via the deprecated single-repository field**: base set has exactly one element, so the single-repository skip applies and behaviour is unchanged.
- **Workspace has no repositories / repo-less run**: unchanged from today; there is nothing to narrow and the gate has no base set to act on.
- **Ticket components change after the run has started**: the scope is read once at run start; mid-run edits to the ticket do not alter a running run. The next run (e.g. after park→resolve) re-reads them.
- **Parking races a state change from the agent's own callbacks**: parking only applies to a run still in normal execution; it must never overwrite a state the run reached through its callback channel (existing parked/awaiting states are preserved — see FR-010).
- **Ticket names extra repositories beyond the agent's scope alongside valid ones**: valid intersection wins; the extras are simply not provisioned (scenario 3 of Story 1) — this is not a park condition because the intersection is non-empty.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST read the ticket's Components (the component names) as part of assembling a run's context, for every run associated with a Jira ticket.
- **FR-002**: The base repository set for a run MUST be resolved by the existing precedence: the agent's configured repository list when non-empty; otherwise the agent's deprecated single-repository setting; otherwise all workspace repositories.
- **FR-003 (D1)**: When scoping applies, the effective repository set MUST be the intersection of the base set with the repositories named by the ticket's components. Components MUST NOT add any repository outside the base set, and the base set MUST NOT contribute repositories the components exclude (when components determine a non-empty intersection).
- **FR-004 (D3)**: Ticket component names that match no workspace repository MUST be silently filtered out while building the candidate set — they never raise an error and never fail the run by themselves. Only an empty *result* may trigger the gate. Config-derived repository names retain their existing fail-loud validation; the two kinds of names MUST NOT share an error path.
- **FR-005 (D2b)**: Ticket scoping MUST be controlled by a per-workspace setting, default off, stored in existing workspace settings (no new persistent structures expected). With the setting off, run behaviour MUST be observably identical to today in every case — components have no effect whatsoever.
- **FR-006 (D2a)**: The fail-closed gate MUST apply only when the workspace setting is on AND the effective base set contains two or more repositories. With a single-repository base set, the resolved set is used directly and no parking occurs, regardless of components.
- **FR-007 (D2)**: When the gate applies and the scope is undeterminable, the system MUST park the run as a blocking human task under exactly one of three conditions, each with its own distinct question text: (1) the ticket has no components — text asks that Components be set on the ticket so the agent knows which repositories to work in; (2) components are present but none maps to a workspace repository — text says none of the ticket's components map to a repository and asks for the repository component to be added; (3) the intersection with the agent's scope is empty — text says the ticket targets repositories this agent is not configured for and asks to check routing or the agent's scope. Parking MUST follow the existing parked-run behaviour (blocked-status transition and question comment on the ticket).
- **FR-008**: The gate MUST evaluate before any repository is provisioned, so a parked run performs no clone/checkout work for the discarded scope.
- **FR-009**: The parking question and details are system-composed; they MUST pass the same scrubbing applied to outgoing content and MUST NOT embed anything beyond ticket key, component names, repository names, and agent identity.
- **FR-010**: Parking MUST honour the existing run-state guard: it applies only to a run still in normal execution and MUST NOT overwrite a state the run reached via its callback channel.
- **FR-011**: Resolving the parked task MUST follow the existing resume loop: the successor run re-reads the ticket (including its current components) and re-resolves scope from scratch, so newly set components take effect without additional wiring.
- **FR-012 (D4)**: An ordinary (non-setup) run MUST allow the agent to obtain an additional repository on demand mid-run into the designated auxiliary location, even when that repository was excluded by narrowing.
- **FR-013 (D5)**: Setup runs MUST be unaffected: their deliberate single-repository scope is preserved and neither narrowing nor the gate applies to them.
- **FR-014**: Runs not associated with any Jira ticket MUST keep today's full base-set behaviour; scoping and the gate do not apply to them.
- **FR-015**: The system MUST record the narrowing decision for each run where scoping applies — components seen, which matched repositories, which were ignored, whether the gate fired and under which condition, and the final effective set — and make it visible to operators through the run's existing reporting surfaces.
- **FR-016**: Component-to-repository matching MUST be an exact comparison of trimmed names, case-insensitive; no fuzzy or partial matching.

### Key Entities

- **Ticket components**: The Jira Components field of the run's ticket — a controlled, per-project vocabulary of names, some of which correspond to workspace repositories and some of which serve unrelated human purposes. Read-only input to scoping; the system never writes it.
- **Base repository set**: The repositories a run could use before ticket input — derived from the agent's configuration or, absent that, the whole workspace. Existing concept from feature 019.
- **Effective repository set**: The intersection of the base set with the repositories named by ticket components; what actually gets provisioned for a narrowed run.
- **Workspace scoping setting**: Per-workspace on/off switch for the whole mechanism, default off; lives among existing workspace settings.
- **Scope-undeterminable human task**: A blocking, system-composed human task carrying one of three distinct condition-specific questions; participates in the existing park→resolve→successor-run loop.
- **Narrowing decision record**: The per-run account of what scoping saw and decided, surfaced to operators.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a ticket whose components name one repository out of an agent's multi-repository scope, the run provisions exactly that one repository — workspace preparation work (repositories fetched and mounted) drops proportionally to the narrowing, e.g. one clone instead of five for a five-repository agent.
- **SC-002**: In 100% of runs parked by the gate, an operator can identify which of the three fix actions applies (set components / add the repository component / fix routing or agent scope) from the queue entry's text alone, without opening logs or transcripts.
- **SC-003**: With the workspace setting off, zero behavioural change is observable across the full existing matrix (tickets with/without components, multi-repository agents, deprecated single-repository agents, repo-less runs, setup runs); the pre-existing automated test suite passes unmodified.
- **SC-004**: The park→fix→resolve loop completes end-to-end without engineering intervention: after a human sets Components and resolves the task, the successor run provisions the correct subset on its own.
- **SC-005**: For any completed or parked run in a scoping-enabled workspace, an operator can reconstruct the scoping decision (inputs, matches, ignores, outcome) from the run's visible record.
- **SC-006**: A run narrowed too tightly still completes: the agent can obtain an out-of-scope repository mid-run without human help.

## Assumptions

- The team maintains the naming convention that Jira components intended to select repositories carry exactly the repository's name; matching is exact on trimmed names and case-insensitive (a picker-sourced value differing only in case must not park a run). No aliasing/mapping table is in scope.
- Repository names are unique within a workspace, so a component name maps to at most one repository.
- The per-workspace setting fits in existing workspace settings storage; no database schema change is expected. If planning concludes a migration is unavoidable, work STOPS until it is justified against the architecture document (constitution/CLAUDE.md rule 5).
- Scope is resolved once at run start from the ticket as then observed; mid-run component edits affect only subsequent runs.
- Runs without a ticket context are exempt from scoping (there is no Components field to read and no ticket for a human to fix).
- The existing human-task queue, blocking-task parking behaviour (Jira blocked transition + question comment), and the resolve→successor-run loop are reused as-is; this feature adds a new system-composed reason to park, not a new lifecycle.
- Ticket components are read at run time from Jira; nothing about components is persisted as authoritative state (Jira remains the source of truth for ticket data, per constitution Principle I).
- Per constitution Principle VI, the scoping resolution logic, the gate, and the park/resume round trip are pipeline logic and ship with unit and integration tests in the same iteration (resolver decision table incl. no-components / none-match / partial match / empty intersection / would-widen / deprecated field / single-repository skip; integration incl. a park→resume→rescope round trip).

## Out of Scope

- Inferring repository scope from Jira Labels, ticket text, or any source other than Components.
- Requiring Components on tickets at creation time, or any Jira-side validation/automation of the Components field.
- An alias/mapping table between component names and repository names.
- Changing setup-run scoping (D5) or the feature-019 multi-repository mechanics themselves.
- Global (non-per-workspace) enablement controls beyond the single per-workspace setting.

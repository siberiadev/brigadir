# Feature Specification: Sprint Sequencing — Guaranteed Execution Order for Blocked-By Chains

**Feature Branch**: `claude/sprint-sequencing-blocked-by-natxlb` (feature directory `022-sprint-sequencing`)

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: sprint-sequencing — guaranteed execution order for tickets chained via blocked-by links. The core issue is a bug: a ticket that enters its trigger status while blocked is silently skipped and never re-considered when its blocker completes, so a sprint laid out as a dependency chain stalls after the first ticket. Full brief (problem analysis, implementation pointers, constraints) preserved verbatim in [design-brief.md](design-brief.md).

## Overview

Today the dependency check runs exactly once — at the moment a ticket changes status. It correctly refuses to start work on a blocked ticket, but there is no counterpart that wakes the ticket up when its blocker finishes: the skip is one log line, nothing is recorded, and no later event re-examines the ticket. A sprint planned as a chain A→B→C therefore executes only A and then silently stops, turning the operator into a manual scheduler.

This feature completes the dependency mechanism: every waiting ticket is re-validated on each reconciliation cycle against fresh board data, so a blocker reaching completion — whether a human moved it or the system moved it after a successful run — releases its dependents within one cycle (with an immediate fast path when the system itself completed the blocker). Released tickets that are fully clear and sitting in an agent's trigger status start automatically. When several tickets unblock at once, they are released in a deterministic order (ticket priority, with a stable tiebreaker). Blocked tickets become visible to operators as "waiting on [blockers]" instead of disappearing silently, and situations that can never resolve on their own (a blocker parked in a status that will never complete, dependency cycles) are surfaced as diagnosable warnings — resolving them remains a human decision.

## Clarifications

### Session 2026-07-18

- Q: How are dependents released when a blocker completes — event-driven push or periodic re-check? → A: Pull is the guarantee: every waiting ticket is re-validated each reconciliation cycle against freshly fetched link data (the board does not mark a dependent as changed when its blocker's status changes, so change-driven observation alone can never see the unblock). Push is a latency fast path only: when the system itself completes a blocker after a successful run, it immediately re-checks that blocker's dependents. Both paths converge on the same outcome (FR-002/FR-003).
- Q: Should the system walk a blocked-by chain to its root and start the root ticket itself? → A: No — chain traversal (including cycle detection) is for visibility and diagnostics only. The system never starts a ticket that is not in an enabled agent's trigger status, even if it blocks others; moving a ticket into a trigger status remains the only way a human hands work to the system (FR-013).
- Q: What happens when a blocker is outside the observed board scope (another sprint, another project)? → A: The system can never resolve that wait itself, so beyond showing the waiting state it creates exactly one deduplicated human task per affected ticket asking to bring the blocker into scope or break the link. On sprint-less (kanban) boards "scope" means the observed board scope (FR-010).
- Q: Is the waiting state persisted or derived on demand? → A: Persisted as part of the ticket's observed board data (diff-cache semantics, never a second source of truth) — the reconciliation re-check needs a durable, enumerable set of waiting tickets to refresh, and the dashboard reads it without extra board calls (FR-001).
- Q: Concurrent-run cap per epic/chain — include or defer? → A: Explicitly deferred; release order stays a start-order guarantee and execution overlap remains governed by existing executor-queue concurrency. If the need materializes, the leading candidate is a per-agent active-run cap (which would also serialize chains naturally) as its own feature (see Out of Scope).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A chained sprint executes itself in order (Priority: P1)

An operator lays out a sprint as a dependency chain: tickets A, B, C with B "blocked by" A and C "blocked by" B, and moves all three into the agent's trigger status at once. The system starts work only on A. When A's run succeeds and A reaches completion, B starts automatically — no human touches the board. When B completes, C follows. The chain walks itself to the end. The same wake-up happens when a blocker is completed by a human directly on the board rather than by a successful run: both completion paths release the dependents.

**Why this priority**: This is the bug fix the feature exists for. Without it, blocked-by chains are a one-way trap: the dependency check blocks correctly but never releases, so autonomous sprint execution — the product's core promise — does not work for any planned-ahead sprint.

**Independent Test**: Create the three-ticket chain, move all tickets into the trigger status at once, let runs succeed, and verify B and then C start with zero human interventions after the initial move. Separately verify the human-completion path: complete a blocker manually on the board and confirm its dependent starts.

**Acceptance Scenarios**:

1. **Given** tickets A, B, C where B is blocked by A and C is blocked by B, all moved into the agent's trigger status at once, **When** the system processes the board, **Then** only A starts; B and C do not.
2. **Given** the same chain with A's run in progress, **When** A's run succeeds and the system moves A to its completion status, **Then** B starts automatically without any human action, and afterwards C starts once B completes.
3. **Given** a ticket D in the trigger status blocked by ticket E, **When** a human completes E directly on the board, **Then** D starts automatically after the system next observes E's completion.
4. **Given** a ticket F in the trigger status blocked by both G and H, **When** G completes but H does not, **Then** F does not start; **When** H also completes, **Then** F starts.
5. **Given** a blocked ticket whose blocker completes, **When** the release fires more than once for the same ticket (e.g. the completion is observed through two paths), **Then** at most one active run exists for that ticket and agent — duplicate protections hold.
6. **Given** a ticket in a non-trigger status blocked by A, **When** A completes, **Then** nothing starts — the release only applies to tickets currently sitting in an agent's trigger status.

---

### User Story 2 - Simultaneously unblocked tickets start in a deterministic order (Priority: P2)

Tickets B and C are both blocked only by A. When A completes, both become eligible at the same moment. Instead of starting in an arbitrary order that can differ between runs of the same sprint, the system releases them by ticket priority — the higher-priority ticket first — and, when priorities are equal, by a stable tiebreaker so the order is fully reproducible.

**Why this priority**: Without a deterministic order, a wave of unblocked tickets starts in effectively random order, which makes sprint behaviour unpredictable and unreproducible — but each individual chain still progresses. It sharpens Story 1's fix rather than being required for it.

**Independent Test**: Block several tickets with distinct priorities (and a pair with equal priority) on a single blocker, complete the blocker, and verify the observed start order matches priority order with the tiebreaker deciding the equal pair — identically across repeated executions of the same scenario.

**Acceptance Scenarios**:

1. **Given** tickets B (high priority) and C (low priority) both blocked only by A and both in the trigger status, **When** A completes, **Then** B is released before C.
2. **Given** two tickets of equal priority both unblocked by the same completion, **When** they are released, **Then** their relative order follows the stable tiebreaker and is identical on every repetition of the scenario.
3. **Given** a ticket with no priority value, **When** it is released together with prioritized tickets, **Then** it is ordered deterministically (after all prioritized tickets, tiebreaker within its group) rather than randomly.

---

### User Story 3 - Blocked tickets are visible as waiting, not silently skipped (Priority: P2)

An operator opens the dashboard and can see that ticket B, although sitting in the agent's trigger status, is not being worked on because it is waiting on tickets A and C — the blocker keys are shown. Previously this state was invisible: the board showed a ticket "ready for the agent" while nothing happened and no surface explained why.

**Why this priority**: Trust in autonomous sequencing requires seeing what it is doing. Without visibility, a correctly waiting ticket is indistinguishable from a stuck system, and every blocked ticket generates a "why isn't this running?" investigation.

**Independent Test**: Put a ticket into the trigger status while its blockers are open, open the dashboard, and verify the ticket is shown as waiting with the exact blocker keys; complete the blockers and verify the waiting indication clears once the ticket starts.

**Acceptance Scenarios**:

1. **Given** a ticket in the trigger status blocked by open tickets A and C, **When** an operator views the dashboard, **Then** the ticket is shown as waiting on A and C (both keys identifiable).
2. **Given** the same ticket, **When** all its blockers complete and it starts, **Then** the waiting indication is gone and the ticket appears with its normal run state.
3. **Given** a blocked ticket, **When** an operator inspects it, **Then** no log access is needed to determine that it is blocked and by which tickets.

---

### User Story 4 - Dead ends and cycles are diagnosable, not silent (Priority: P3)

A blocker is parked in a status that will never reach completion (e.g. declined work), or two tickets block each other in a cycle. Nothing in the chain will ever proceed on its own. The system does not attempt to resolve this — breaking a cycle or re-planning is a human decision — but it surfaces the condition as a warning an operator can find (in the dashboard and in logs), so the sprint does not just quietly stop.

**Why this priority**: These are rarer conditions than plain waiting, and the system's obligation is only to make them findable. The core sequencing (Stories 1–3) is valuable without this, but long-term trust requires that "will never proceed" is distinguishable from "still waiting".

**Independent Test**: Construct a two-ticket cycle in the trigger status and, separately, a dependent whose blocker is moved to a never-completing status; verify each condition is surfaced as a warning identifying the tickets involved, and that no runs start for them.

**Acceptance Scenarios**:

1. **Given** tickets A and B that block each other, both in the trigger status, **When** the system processes the board, **Then** neither starts and a warning identifying the cycle (both keys) is visible to operators.
2. **Given** a ticket waiting on a blocker that sits in a never-completing status outside the completion category, **When** an operator reviews the board state, **Then** a warning distinguishes this dead-end wait from ordinary waiting.
3. **Given** a surfaced cycle or dead-end, **When** a human resolves it on the board (breaks the link, completes or re-plans the blocker), **Then** the affected tickets proceed through the normal release path and the warning clears.
4. **Given** a ticket in the trigger status whose blocker lives outside the observed board scope (e.g. another sprint), **When** the system processes the board, **Then** exactly one human task is created for that ticket asking to bring the blocker into scope or break the link — and repeated reconciliation cycles do not create duplicates.

---

### Edge Cases

- **Blocker completes before the dependent ever enters the trigger status**: nothing to release at that moment; when the dependent later enters the trigger status, the ordinary dependency check finds it clear and it starts — unchanged behaviour.
- **Dependent with multiple blockers completing at different times**: released exactly once, on the last blocker's completion (Story 1, scenario 4); intermediate completions change only the displayed waiting list.
- **Blocker is reopened after its dependent already started**: started runs are not recalled or cancelled by a reopened blocker; the dependency check applies to future starts only.
- **Blocker completes with a "declined"-style resolution that still lands in the completion category**: the dependent is released — completion category is the single source of "done", matching the existing dependency check. Conversely, a rejected blocker parked outside the completion category is a dead end surfaced by Story 4.
- **Blocker lives outside the observed board scope** (another sprint, another project, or filtered out): its completion may never be observed; the dependent shows as waiting and gets a single deduplicated human task (Story 4, FR-010) rather than silently vanishing. If the blocker later enters the scope and completes, the normal release path applies.
- **The release wave races a human manually toggling the dependent's status**: both paths funnel through the existing duplicate protections; at most one active run per ticket and agent results.
- **The agent matching a released ticket was disabled while the ticket waited**: release follows the same agent-matching rules as a normal trigger — a disabled agent starts nothing.
- **Ticket blocked at release-check time by a blocker completed only in the system's records but not yet visible on the board**: the board remains the source of truth; release decisions follow the observed board state, never internal bookkeeping alone.
- **A wave larger than available execution capacity**: release order is the guaranteed *start* order; execution overlap and throughput remain governed by existing capacity settings (see Assumptions — order does not serialize execution).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a ticket in an agent's trigger status is found blocked, the system MUST record that state — including the set of blocking ticket keys — rather than discarding the event; the record MUST be kept current as blockers complete. The record is durable and enumerable (so each reconciliation cycle can find every waiting ticket without rescanning the board) and is a cache of observed board data, never a second source of truth.
- **FR-002**: On each reconciliation cycle the system MUST re-validate every recorded waiting ticket against freshly fetched board data — the board does not mark a dependent as changed when its blocker's status changes, so the re-check MUST read the waiting tickets' current dependency data directly (batched, not per-ticket round-trips) rather than relying on change-driven observation. Each waiting ticket that is currently in an enabled agent's trigger status and clear on ALL of its blockers MUST be started automatically, with no human action. The re-check's board fetch (and the FR-003 fast path) MUST stay inside the workspace's board/sprint scope and its optional `scope_jql` filter (FR-038 of feature 002-jira-core) — a candidate is a local-cache hit with no Jira awareness of its own and may have drifted out of scope since it was cached (sprint ended, `scope_jql` narrowed); FR-038 already requires that such a ticket never triggers an agent, and this release path is not exempt.
- **FR-003**: The periodic re-validation of FR-002 is the correctness guarantee and MUST release dependents regardless of how the blocker completed — a human acting on the board or the system's own post-run transition. When the system itself completes a blocker after a successful run, it SHOULD additionally re-check that blocker's dependents immediately as a latency fast path; the fast path is an optimization and MUST NOT be the only release mechanism. Both paths MUST produce the same outcome for dependents.
- **FR-004**: A dependent with multiple blockers MUST NOT start until every one of its blockers is in the completion category.
- **FR-005**: Every start produced by the release path MUST pass through the same duplicate-run protections as existing trigger paths, preserving the guarantee of at most one active run per ticket-and-agent pair; the release mechanism MUST NOT weaken or bypass any existing protection layer.
- **FR-006**: When multiple tickets become eligible from the same completion, the system MUST release them in deterministic order: by ticket priority (higher first), then by a stable tiebreaker on the ticket key for equal priorities. The same scenario MUST produce the same order on every execution.
- **FR-007**: The system MUST ingest and retain each ticket's priority as part of its observed board data so the ordering in FR-006 is available at release time; a ticket without a priority value MUST still be ordered deterministically.
- **FR-008**: The dashboard MUST present a blocked ticket in a trigger status as waiting, identifying the blocker ticket keys, and MUST clear that presentation once the ticket starts or leaves the trigger status.
- **FR-009**: The system MUST surface, as an operator-visible warning, a dependency cycle among tickets in trigger statuses, identifying the tickets involved; the system MUST NOT attempt to break the cycle itself.
- **FR-010**: The system MUST surface, as an operator-visible warning distinguishable from ordinary waiting, a dependent whose blocker sits in a state that cannot reach the completion category through normal work (dead-end wait); resolution remains a human action, after which the normal release path applies. For a blocker outside the observed board scope (another sprint or project — a wait the system can never resolve itself), the system MUST additionally create exactly one human task per affected ticket (deduplicated across cycles) asking a human to bring the blocker into scope or break the link; on sprint-less boards "scope" means the observed board scope.
- **FR-011**: The release path MUST NOT alter the state of runs that are already active, parked for a human, or finished; existing finalization and state-protection guarantees apply unchanged to anything the release path touches.
- **FR-012**: All board writes involved in this feature remain system-performed through the existing write path; the feature MUST NOT grant agents any ability to write to the board.
- **FR-013**: Dependency-chain traversal — walking blocked-by links toward the chain's root, including cycle detection — is for visibility and diagnostics ONLY. The system MUST NOT start work on any ticket that is not currently in an enabled agent's trigger status, even if that ticket blocks others; moving a ticket into a trigger status remains the only way a human hands work to the system.

### Key Entities

- **Ticket**: a unit of sprint work observed from the board; now additionally carries its priority and its dependency links (which tickets block it).
- **Dependency link**: a directed "blocked by" relationship between two tickets; only inward "blocked by" links gate execution, matching the existing dependency check.
- **Waiting state**: the operator-visible condition of a ticket that is in a trigger status but gated by open blockers; identifies the blocker keys; cleared on release.
- **Release event**: a re-evaluation of the waiting set — periodic (every reconciliation cycle) or fast-path (immediately after the system completes a blocker); produces zero or more ordered ticket starts.
- **Sequencing warning**: an operator-visible diagnostic for a condition that will never self-resolve — a dependency cycle or a dead-end blocker.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A three-ticket chain (A→B→C via blocked-by) moved into the trigger status all at once completes end-to-end with **zero** human interventions after the initial move — previously this required a manual status toggle for every link in the chain.
- **SC-002**: After a blocker's completion becomes observable, each eligible dependent starts within one reconciliation cycle — no dependent ever waits indefinitely on an already-completed blocker.
- **SC-003**: Across any release wave, duplicate starts are zero: at most one active run exists per ticket-and-agent pair at all times.
- **SC-004**: Repeating an identical simultaneous-unblock scenario (≥3 tickets, mixed priorities) 10 times yields the identical start order 10 times.
- **SC-005**: For 100% of blocked tickets in a trigger status, an operator can identify the blocking ticket keys from the dashboard alone, without log access.
- **SC-006**: Dependency cycles and dead-end waits among trigger-status tickets are surfaced as warnings within one reconciliation cycle of becoming observable, and no runs start for the affected tickets.

## Assumptions

- **"Blocked" semantics are unchanged**: only inward "is blocked by" links gate execution; outward "blocks" and other link types never do. "Complete" means the board's completion status category, exactly as the existing dependency check defines it — including declined-style resolutions that land in that category.
- **Deterministic order is a start-order guarantee, not serialization**: released tickets begin in the guaranteed order, but their runs may overlap per existing execution-capacity settings. Serializing execution within a chain/epic is the deferred cap decision below.
- **Priority source**: the board's standard priority field, using its scheme's ranking; tickets without a priority value order after prioritized ones, with the same stable tiebreaker.
- **Visibility derives from already-observed board data** (dependency links the system already collects); no new operator input is required to see waiting states. The waiting set is persisted with the ticket's observed data (diff-cache semantics) so it is enumerable and readable without extra board calls.
- **Re-validation refreshes waiting tickets directly**: the board does not mark a dependent as changed when its blocker's status changes, so each cycle re-reads the waiting set's dependency data in a single batched request; querying the board for "unblocked tickets" is not possible (board query language cannot filter on a linked ticket's status).
- **Blockers outside the observed scope** cannot have their completion observed; such waits get a single deduplicated human task (Story 4, FR-010) — legitimate long waits, not errors.
- **Reconciliation cadence bounds release latency**: "automatic" means within the system's normal observation cycle, not instantaneous; the system's own post-run completion additionally releases dependents immediately via the fast path.

## Out of Scope

- **Concurrent-run cap per epic/chain** — a limit so a wave of N simultaneously released tickets does not pile into the same repository in parallel. **Deferred by clarify decision 2026-07-18**: execution overlap remains governed by existing executor-queue concurrency; the leading candidate if the need materializes is a per-agent active-run cap (which would also serialize chains naturally), as its own feature.
- **Planner / agent-driven ticket creation from an epic** — deferred by a separate decision.
- **Cross-project reading of knowledge/contracts (data models)** — future feature 021 (its number is reserved; this directory is 022 for that reason).
- **Repository filtering via the ticket's Components field** — separate in-progress work (feature 020, on top of 019 multi-repo runs); this feature must not conflict with it on stored ticket data.
- **Cancelling or recalling runs already started** when a blocker is reopened — the dependency check gates starts only.

## Revision History

- **2026-07-21 — Amendment: FR-002 cross-references FR-038 (scope_jql compliance fix).** `DependencyReleaseService`'s release re-fetch and its FR-003 fast path were found to ignore the workspace's `scope_jql` filter, triggering agents for tickets a workspace's scope explicitly excludes — a violation of feature 002-jira-core's existing FR-038 ("a ticket that does not satisfy `scope_jql` is never ingested and never triggers an agent — even while it sits in an agent's trigger status"), reproduced live on a scrum board running two simultaneously active sprints where `scope_jql` pinned one. FR-002 amended in place to state the re-check's board fetch must stay inside board/sprint scope + `scope_jql`, cross-referencing FR-038; no other requirement, story, success criterion, or scenario was renumbered or rewritten.

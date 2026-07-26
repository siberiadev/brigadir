# Feature Specification: Linked-Ticket Branch Inheritance + Configurable Dependency Release Status

**Feature Branch**: `claude/speckit-prompt-spec-9ccaa4` (feature directory `032-linked-ticket-branch-inheritance`)

**Created**: 2026-07-25

**Status**: Draft

**Input**: Feature brief "linked-ticket branch inheritance + configurable dependency release status" — tickets chained with Jira "is blocked by" links are unusable today because (1) a dependent may only start once its blocker reaches the `done` status category, even when teams want it to start as soon as the blocker's code is in review, and (2) a dependent starts from the repository's default branch, so its blocker's unmerged work is invisible to it.

## Overview

Boards chain tickets with Jira "is blocked by" links: a planner ticket blocks a developer ticket, a backend ticket blocks a frontend ticket, one change is spread across several tickets that must land together. Two gaps make these chains fail in practice.

**The gate is all-or-nothing.** A dependent ticket may start only when its blocker's status category is `done`. Teams routinely want the next ticket to start earlier — as soon as the blocker's code exists and is in review — because the blocker's PR may sit unmerged for days while the chain idles.

**Work is lost between tickets.** Branch handoff (feature 023) resolves a run's start point from prior runs *of the same ticket* only. A dependent ticket therefore starts from the repository's default branch, and the blocker's unmerged branch — the entire reason the link exists — is invisible to it. Teams that deliberately keep a multi-ticket change out of the default branch until the whole set is finished find the default-branch start actively wrong, not merely suboptimal.

Cross-service chains are the same problem from another angle: a frontend ticket blocked by a backend ticket needs the backend's *unmerged* branch checked out beside it to build against.

This feature lets an operator (a) choose the blocker status at which dependent tickets may start, per workspace, and (b) has every dependent run start from its blocker's reported code instead of the default branch — with loud, diagnosable behaviour whenever the expected code is not where it should be. Design bias: minimal, workspace-level, no new domain entities; where the mechanism falls short, the next lever is agent instructions, not more system machinery.

## Clarifications

### Session 2026-07-25 (decisions taken with the feature brief; settled, not re-opened)

- Q: Where does the release threshold live — per agent, per link, per workspace? → A: One workspace setting, `dependency_release_status`, a Jira status name stored in the existing workspace settings blob. No schema migration, no new entity. A per-agent override is deliberately deferred (v1 keeps the per-ticket blocked/waiting cache a single truth per ticket; a per-agent threshold would make one ticket simultaneously released for one agent and waiting for another, which that cache cannot express, and would break the clear-on-release step of the release fast path).
- Q: What are the exact release semantics? → A: An inward "is blocked by" link is satisfied when the blocker's status name equals the setting **OR** the blocker's status category is `done`. Unset ⇒ today's behaviour exactly. The `OR done` part is not an ordering model — Jira statuses are unordered; it is only a guard against a blocker that jumps straight past the configured status (e.g. In Progress → Done without ever being observed In Review), which would otherwise strand its dependents forever. The UI stays a single status select.
- Q: How does a dependent run know its blockers at prepare time? → A: The per-ticket blocked-by cache changes meaning from "written only while observed waiting, cleared on release" (which makes it null exactly when inheritance needs it) to "all inward blocked-by keys as last observed on the board", written on every poller observation next to the last-seen status. Link data is already in the poll fields — no extra Jira calls. The waiting-classification field keeps its current meaning (null when not waiting). Both remain diff caches, never a source of truth (Principle I).
- Q: Where do blocker branches enter the start-point precedence? → A: Between "this ticket's own prior work" and "default branch". Full precedence: (1) an explicitly named prior run (rework / human-resume / triage handoff) — unchanged; (2) latest succeeded run on this ticket — unchanged; (3) blocker branches — for each observed blocker key, that ticket's latest succeeded run that reported artifacts, mapped onto the mounted repositories with the existing matching rules (exact name, then one case-insensitive fallback, nothing fuzzy); (4) default branch. Inheritance is per repository, exactly like today's handoff; there is no run-level branch and no cross-repo merging.
- Q: Two blockers report branches for the same repository — crash, pick one, or merge? → A: Merge at prepare time: the first branch becomes the start ref, the rest are merged sequentially into the detached worktree before the agent starts. A merge conflict fails the run loudly, naming the repository and the branches, and raises a human task. Rationale for spending complexity here: multi-blocker (diamond) shapes are the common case for "one change spread across several tickets"; crashing on them would make the feature unusable for its main scenario. The merge commit becomes the run's recorded start commit, so the feature-024 completion gate keeps working unchanged. Merging is never delegated to the agent — the system has already done it deterministically and recorded it.
- Q: What happens when an expected branch is missing? → A: Three rules, distinguished by whose branch it is and the blocker's status — no new report fields needed. (1) A branch reported by a previous run *of this ticket* absent from origin: loud crash, unchanged from feature 023. (2) A blocker's branch absent from origin while the blocker **is** in the `done` category: start from the default branch, quietly — merged-and-deleted is the normal end state. (3) The blocker reported no branch at all, or its branch is gone, and the blocker is **not** done (i.e. this run only started because of the early-release setting): start from the default branch **and** raise one deduplicated human task naming the ticket, the blocker and the repository.
- Q: How do cross-repository (cross-service) chains work? → A: Nothing is merged across repositories; a cross-service dependency is satisfied by *mounting* the blocker's repository detached at the blocker's branch. Whether that repository is mounted is decided by existing configuration: the agent's base repository set, optionally narrowed by ticket Components (feature 020 — components select within the base set, never widen it). New behaviour: when a blocker reported artifacts for a repository this run does **not** mount, record it on the run timeline and raise one deduplicated human task explaining the two fixes (add the component to the dependent ticket, or widen the agent's repository scope). Unmatched entries from the ticket's *own* prior work keep today's observability-only behaviour (the self-clone escape hatch is legitimate).
- Q: What does the agent see? → A: Facts, not instructions. The system decides and materialises the base; the wrapper only explains it — per repository: provenance, role, and PR base (e.g. "your work, based on origin/main" / "DEPENDENCY — branch X from ST3-101, not yet in main; read it and build against it, do not modify unless the task says so" / "continue branch X from ST3-101, already merged into your start point; open your PR against X, not main"). Plus a bounded "Linked tickets" block (key, status, branch, PR URL), nearest blockers first, capped like every other handoff field.
- Q: Observability? → A: Reuse the existing per-repo start-ref timeline event; add decisions `inherited_from_blocker`, `merged_blockers`, `blocker_branch_merged`, `blocker_no_artifact`, `blocker_artifacts_unmounted`.

### Decisions taken in this spec (were open in the brief)

- Q: Setting name, dashboard placement, validation? → A: Name stays `dependency_release_status`. It lives on the workspace settings page alongside the existing workspace-level pipeline settings, as a single status select populated from the statuses the system has observed on the board, with free-text entry allowed (blockers may live in another Jira project whose statuses the board has never shown). If the configured name matches no status the system has observed, the dashboard shows a non-blocking warning; at gate time an unmatched name simply never equals any blocker status, so behaviour degrades to the done-category rule — and the release pass records a diagnostic naming the unmatched setting rather than silently never matching. Matching is case-insensitive (Jira status names are display strings).
- Q: Human-task wording and dedup keys for the three new task kinds? → A: Three kinds — `blocker_branch_lost` ("Dependent <ticket> started early from the default branch: blocker <blocker> has not reported a usable branch for repository <repo>"), `blocker_merge_conflict` ("Run on <ticket> failed: branches <a> and <b> from blockers <k1>, <k2> conflict in repository <repo>; resolve and rework"), `blocker_repo_unmounted` ("Blocker <blocker> has work in repository <repo>, which runs for <ticket> do not mount; add the component to <ticket> or widen the agent's repository scope"). Dedup key per kind: (workspace, dependent ticket, blocker key, repository, kind) — while such a task is open, no duplicate is created; repeated runs re-encountering the same condition add a timeline event only.
- Q: Where does the "Linked tickets" block go, and its budget? → A: In the wrapper's existing handoff/prior-work section (one place; the wrapper is the agent's single briefing). Ordering: direct blockers first, in deterministic key order; capped at 10 entries and per-field truncation consistent with existing handoff caps; deeper transitive blockers are out of the block (their effect is already materialised in the checkout).
- Q: How does the dashboard surface an early-released run and its inherited base? → A: Through the run timeline: the release event names the setting-matched status when release happened before the done category, and the per-repo start-ref events carry the new decisions with blocker ticket and branch. No new dashboard page or run field; the timeline is the diagnosis surface (feature 026 conventions apply to the new event payloads).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A dependent ticket starts as soon as its blocker is in review (Priority: P1)

An operator sets the workspace's dependency release status to "In Review". A blocker ticket's agent finishes its work and the system transitions the blocker to In Review. Within one reconciliation cycle, the dependent ticket — until now held by the gate — is released and its agent starts, days before the blocker's PR is merged.

**Why this priority**: This is half of the headline problem — chains idle for days while a finished-but-unmerged blocker sits in review. Without it, the inheritance half has nothing to release early.

**Independent Test**: Configure the setting, move a blocker into the configured status, and verify the dependent's run is dispatched; unset the setting and verify the dependent waits for the done category exactly as today.

**Acceptance Scenarios**:

1. **Given** the setting is "In Review" and ticket B is blocked by ticket A which is In Progress, **When** A moves to In Review, **Then** B's gate clears and B's agent is dispatched through the normal release pass.
2. **Given** the setting is "In Review", **When** A moves straight from In Progress to Done without ever being observed In Review, **Then** B is still released — the done category always satisfies the link.
3. **Given** the setting is unset, **When** A moves to In Review, **Then** B stays blocked; it is released only when A reaches the done category (today's behaviour, byte-identical).
4. **Given** the setting is "In Review" and B is blocked by A (In Review) and C (In Progress), **Then** B stays blocked until C also satisfies the rule — every inward link must be satisfied, as today.
5. **Given** a configured status name that matches no status ever observed on the board, **When** the release pass evaluates a gate, **Then** behaviour equals the done-category rule and a diagnostic naming the unmatched setting is recorded; the dashboard shows a warning next to the setting.
6. **Given** status names differing only in case ("in review" vs "In Review"), **When** the gate compares them, **Then** they match.

---

### User Story 2 - A dependent run starts from its blocker's unmerged branch (Priority: P1)

Ticket B is blocked by ticket A. A's run pushed branch `run/A` in repository `product` and reported it. B is released (early or on done) and B's agent finds `product` checked out at `run/A`'s tip — A's work is its starting point, not something it must rediscover or that silently never existed for it.

**Why this priority**: This is the other half of the headline problem and the core of the feature: without inheritance, early release would start dependents from a base that is missing exactly the work they depend on.

**Independent Test**: Complete a run on A that reports a branch, release B, and verify B's worktree HEAD for that repository is the tip of A's reported branch and the timeline records the inheritance decision.

**Acceptance Scenarios**:

1. **Given** B has no prior runs of its own and its blocker A's latest succeeded run reported `{repo: product, branch: run/A}` present on origin, **When** B's run prepares, **Then** `product` is checked out detached at `run/A`'s tip and the start-ref event records decision `inherited_from_blocker` naming A and the branch.
2. **Given** B has its own prior succeeded run with a reported branch, **When** B's next run prepares, **Then** B's own branch wins over any blocker branch (own work outranks inherited work).
3. **Given** a rework of B naming a specific prior run, **When** that run reported a branch, **Then** it outranks both B's other runs and A's branches (existing precedence, unchanged at the top).
4. **Given** A's report names a repository B's run does not mount and B's run mounts other repositories A never touched, **Then** each mounted repository is resolved independently — inherited where a blocker branch matches, default branch where nothing matches.
5. **Given** A's branch was merged and deleted and A is in the done category, **When** B prepares, **Then** the repository starts from the default branch quietly — no crash, no human task; the start-ref event records decision `blocker_branch_merged`.
6. **Given** B started only because of the early-release setting (A not done) and A reported no branch, or A's reported branch is absent from origin, **When** B prepares, **Then** the repository starts from the default branch, the start-ref event records `blocker_no_artifact`, and one human task of kind `blocker_branch_lost` is raised (deduplicated: a second run while the task is open adds only a timeline event).
7. **Given** a branch reported by a previous run of B itself is absent from origin, **When** B prepares, **Then** the run fails loudly — feature 023's rule is unchanged.
8. **Given** the wrapper for B's run, **Then** each repository states its provenance ("continue branch run/A from A, already merged into your start point; open your PR against run/A" vs "your work; based on the default branch"), and a "Linked tickets" block lists A with key, status, branch and PR URL, capped and ordered per the clarification.

---

### User Story 3 - Two blockers' branches for the same repository are merged before the agent starts (Priority: P2)

Ticket D is blocked by B and C, both of which branched off the same change in repository `product` (a diamond: A split into B and C, D rejoins them). D's run starts from a deterministic merge of B's and C's branches — the system merged them at prepare time; the agent never has to reconcile its own base.

**Why this priority**: Diamond shapes are the common case for "one change spread across several tickets". Ships after Story 2 because it composes on single-blocker inheritance, but without it the main multi-ticket scenario crashes or picks an arbitrary parent.

**Independent Test**: Complete runs on two blockers that report different branches of the same repository, release the dependent, and verify its start commit is a merge commit containing both branches' work.

**Acceptance Scenarios**:

1. **Given** blockers B and C reported branches `run/B` and `run/C` for `product` and they merge cleanly, **When** D prepares, **Then** `product` is checked out at a merge commit containing both, the merge commit is recorded as the run's start commit, and the start-ref event records decision `merged_blockers` naming both branches and tickets.
2. **Given** the same setup but the branches conflict, **When** D prepares, **Then** the run fails loudly naming the repository and both branches, and one human task of kind `blocker_merge_conflict` is raised (deduplicated).
3. **Given** the merged start commit, **When** D's agent commits on top and the feature-024 completion gate compares the final state against the start commit, **Then** the gate behaves exactly as for any other start ref — no special case.
4. **Given** three or more blocker branches for one repository, **When** D prepares, **Then** they are merged sequentially in deterministic order; the order is recorded.

---

### User Story 4 - A cross-service dependent builds against its blocker's unmerged service (Priority: P2)

A frontend ticket is blocked by a backend ticket whose API change is pushed but unmerged. The frontend run mounts `backend/` detached at the blocker's branch and `frontend/` at its own default branch. The agent reads the real API it must build against; the wrapper marks `backend/` as a dependency to read, not modify.

**Why this priority**: Cross-service chains are the second named use case. Depends on Story 2's resolution machinery but exercises the mounting dimension rather than the same-repo dimension.

**Independent Test**: Configure an agent whose repository set includes both services, complete a backend blocker run reporting a backend branch, release the frontend ticket, and verify the backend repository is mounted at the blocker's branch while the frontend repository is on its default branch.

**Acceptance Scenarios**:

1. **Given** the dependent's agent mounts `backend` and `frontend` and the blocker reported a branch only for `backend`, **When** the dependent prepares, **Then** `backend` is at the blocker's branch (decision `inherited_from_blocker`), `frontend` at its default branch, and the wrapper labels `backend` as "DEPENDENCY — read it and build against it, do not modify unless the task says so".
2. **Given** the blocker reported artifacts for a repository the dependent's run does **not** mount (base set, optionally narrowed by Components, excludes it), **When** the dependent prepares, **Then** the run proceeds, the timeline records `blocker_artifacts_unmounted` naming the repository and blocker, and one human task of kind `blocker_repo_unmounted` is raised explaining the two fixes (add the component to the dependent ticket, or widen the agent's repository scope), deduplicated.
3. **Given** unmatched artifact entries from the dependent's *own* prior runs, **Then** today's observability-only behaviour is kept — no human task (the self-clone escape hatch is legitimate).
4. **Given** the dependent's agent commits in the mounted dependency repository without reporting a branch for it, **Then** the existing feature-024 completion gate fails the run — unchanged, and relied upon.

---

### User Story 5 - An operator can diagnose where a dependent started and why (Priority: P3)

Opening a run, an operator sees per repository which ref it started from and what decided it — inherited from which blocker, merged from which branches, fallen back to default and why — and sees in the release event that the run started early under the configured status. Human tasks point at the exact ticket/blocker/repository combination that needs attention.

**Why this priority**: Inheritance adds a second source of start refs; "it started from the wrong place" must stay a diagnosable question or trust in autonomous chains erodes. Stories 1–4 work without this; operating them over time does not.

**Independent Test**: Exercise each decision path and verify each produces the expected timeline decision and, where specified, exactly one open human task per dedup key.

**Acceptance Scenarios**:

1. **Given** any dependent run, **When** an operator opens its timeline, **Then** every mounted repository has a start-ref event whose decision is one of the existing decisions or `inherited_from_blocker`, `merged_blockers`, `blocker_branch_merged`, `blocker_no_artifact` — the boring cases are recorded too.
2. **Given** a release that happened because of the configured status (blocker not yet done), **When** the operator inspects the dependent's dispatch, **Then** the release record names the blocker and the matched status.
3. **Given** two consecutive runs hitting the same missing-blocker-branch condition, **Then** one human task exists (the dedup key held) and both runs carry the timeline event.
4. **Given** the new timeline events, **Then** they render under the feature-026 readability rules — key/value payloads, no raw JSON dumps.

---

### Edge Cases

- **Blocker skips the configured status entirely** (In Progress → Done): released by the done-category half of the rule; never stranded (Story 1, scenario 2).
- **Configured status exists only in the blocker's project, not the board's**: the select allows free text; matching is by name against the blocker's observed status, so it works; the dashboard warning about "never observed on this board" is advisory, not blocking.
- **Blocker has no succeeded run at all** (e.g. a human did the work outside the system and moved the status): treated as "no branch reported" — done ⇒ quiet default branch; not done ⇒ default branch + `blocker_branch_lost` task.
- **Blocker's ticket is out of scope for the system** (different project, not on the board): the gate's existing `out_of_scope` classification is unchanged; inheritance simply finds no runs and follows the missing-branch rules.
- **Dependency cycles** (A blocked by B blocked by A): existing `cycle` classification and behaviour unchanged; this feature adds no new cycle handling.
- **Blocked-by cache is stale or empty at prepare time** (ticket never observed since the meaning change): inheritance sees no blockers and falls through to the default branch; the next poller observation backfills the cache. No crash, no guess.
- **Blocker is reworked or force-pushed after the dependent started**: out of scope (each new run re-resolves its base at prepare; only an in-flight run can be stale — accepted).
- **Two parallel dependents of one blocker**: both read the blocker's branch and each pushes its own branch; no write race, no serialisation needed (out of scope by design).
- **Blocker's report is in the legacy flat form (no repo name)**: existing attribution rule applies — attributable only when exactly one repository is mounted; otherwise it is unmatched and follows the missing/unmounted rules.
- **Duplicate repo names or duplicate blocker entries in reports**: first entry wins deterministically, as today.
- **Merge of blocker branches succeeds but produces an empty diff against default** (blockers already merged upstream moments earlier): harmless — the merge commit still becomes the start commit; the completion gate compares against it as usual.
- **Setting changed between release and prepare**: the gate decision was made at release time; prepare consults only the observed blocked-by keys and blocker statuses at prepare time for the missing-branch asymmetry — each step uses its own observation, neither re-litigates the other.

## Requirements *(mandatory)*

### Functional Requirements

**Release threshold**

- **FR-001**: The workspace settings MUST accept an optional `dependency_release_status` — a single Jira status name — with no database schema migration; absence of the value MUST leave gate behaviour byte-identical to today.
- **FR-002**: The dependency gate MUST treat an inward "is blocked by" link as satisfied when the blocker's status name equals the configured value (case-insensitive) OR the blocker's status category is `done`; a ticket is released only when every inward link is satisfied.
- **FR-003**: Both gate evaluation paths — the status-change path and the pull-based release pass — MUST apply the same rule from the same workspace setting; all other feature-022 behaviour (pull pass, release fast path, deterministic release order, `cycle`/`dead_end`/`out_of_scope` classification) MUST remain unchanged.
- **FR-004**: The dashboard MUST offer the setting as a single status select populated from statuses observed on the board, allowing free-text entry, and MUST show a non-blocking warning when the configured name has not been observed; the release pass MUST record a diagnostic when the configured name matches no blocker rather than silently never matching.

**Blocked-by observation**

- **FR-005**: The poller MUST record, on every observation of a ticket, the full set of inward blocked-by keys as seen on the board (using link data already present in the poll fields — no additional Jira calls), independent of whether the ticket is currently waiting; the waiting-classification field keeps its current meaning. Both remain caches, never authoritative (Principle I).

**Branch inheritance**

- **FR-006**: Start-point resolution MUST follow the precedence: explicitly named prior run → latest succeeded run of this ticket → blocker branches (per observed blocker key, that ticket's latest succeeded run reporting artifacts) → default branch; resolution is per repository, using the existing matching rules (exact name, one case-insensitive fallback, nothing fuzzy).
- **FR-007**: When two or more blockers supply branches for the same repository, the system MUST merge them deterministically at prepare time before the agent starts; the resulting merge commit MUST be recorded as the run's start commit so the completion gate operates unchanged. A merge conflict MUST fail the run loudly, naming the repository and branches, and raise a `blocker_merge_conflict` human task.
- **FR-008**: Missing-branch behaviour MUST follow the asymmetry: (a) this ticket's own reported branch absent from origin ⇒ loud failure (unchanged); (b) blocker's branch absent while blocker is in the done category ⇒ quiet default-branch start; (c) blocker not done and no usable blocker branch ⇒ default-branch start plus one deduplicated `blocker_branch_lost` human task naming ticket, blocker and repository. No new report fields are introduced to support this.
- **FR-009**: When a blocker reported artifacts for a repository the dependent run does not mount, the system MUST record a `blocker_artifacts_unmounted` timeline event and raise one deduplicated `blocker_repo_unmounted` human task naming the two available fixes; unmatched entries from the ticket's own prior work MUST keep today's observability-only handling.
- **FR-010**: Repository mounting MUST remain governed by existing configuration only (agent base repository set, optionally narrowed by ticket Components); this feature MUST NOT widen a run's repository scope automatically.

**Human tasks**

- **FR-011**: The three new human-task kinds (`blocker_branch_lost`, `blocker_merge_conflict`, `blocker_repo_unmounted`) MUST be deduplicated on (workspace, dependent ticket, blocker key, repository, kind): while a matching task is open, a recurrence MUST add only a timeline event. Task text MUST name the dependent ticket, the blocker and the repository, and state the operator's next action.

**Agent-facing context**

- **FR-012**: The wrapper MUST state, per mounted repository, factual provenance and role: own work on the default branch; a dependency mounted at a named blocker branch not yet in the default branch (read/build-against, do not modify unless tasked); or a continuation whose start point already contains a named merged branch, including the branch the agent should target with its PR. The system decides and materialises the base; the wrapper never instructs the agent to perform merges.
- **FR-013**: The wrapper MUST include a "Linked tickets" block — key, status, branch, PR URL per direct blocker — ordered deterministically with direct blockers first, capped at 10 entries with per-field truncation consistent with existing handoff caps.

**Observability**

- **FR-014**: Every mounted repository of every run MUST produce a start-ref timeline event; the decision vocabulary MUST be extended with `inherited_from_blocker`, `merged_blockers`, `blocker_branch_merged`, `blocker_no_artifact`, `blocker_artifacts_unmounted`, each payload naming the blocker ticket(s) and branch(es) involved; new payloads MUST follow the feature-026 timeline readability rules.
- **FR-015**: When a ticket is released before its blocker reaches the done category, the release record MUST name the matched status so an early release is distinguishable from a done-category release on the dashboard.

**Safety and compatibility**

- **FR-016**: With `dependency_release_status` unset and no blocker branches present, all observable behaviour — gate decisions, start refs, timeline events, wrapper content — MUST be identical to today.
- **FR-017**: All new pipeline logic MUST ship with tests in the same change (Principle VI): unit coverage for the gate predicate, the precedence chain, the multi-blocker merge and the full missing-branch matrix; integration coverage for "blocker in the configured status ⇒ dependent starts from the blocker's branch" alongside the existing dependency-gate and sprint-sequencing integration suites.

### Key Entities

- **Dependency release status (workspace setting)**: optional Jira status name in the existing workspace settings blob; the threshold at which a blocker satisfies its outgoing links early. Absent ⇒ done-category rule only.
- **Blocked-by observation (per ticket)**: the set of inward blocked-by keys as last observed on the board, refreshed on every poll; input to release evaluation and to inheritance at prepare time. A cache, never a source of truth.
- **Blocker branch (per repository)**: a branch reported in a blocker ticket's latest succeeded run's artifacts, mapped onto the dependent run's mounted repositories; the inherited start point.
- **Merged start commit**: the deterministic merge of multiple blocker branches for one repository, recorded as the run's start commit; the base the completion gate measures against.
- **Human task kinds**: `blocker_branch_lost`, `blocker_merge_conflict`, `blocker_repo_unmounted` — each deduplicated on (workspace, dependent ticket, blocker key, repository, kind).
- **Start-ref decisions (timeline)**: existing vocabulary plus `inherited_from_blocker`, `merged_blockers`, `blocker_branch_merged`, `blocker_no_artifact`, `blocker_artifacts_unmounted`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the release status configured, a dependent ticket's run is dispatched within one reconciliation cycle of its last blocker reaching the configured status — days earlier than waiting for merge, with zero manual re-triggering.
- **SC-002**: A dependent run's checkout contains 100% of its blocker's reported, still-present work at start — verified by the start commit containing the blocker branch tips — for single-blocker, diamond and cross-service shapes alike.
- **SC-003**: A chain of linked tickets completes end-to-end with no human branch surgery (no manual merges, checkouts or re-basing between tickets) in the supported scenarios.
- **SC-004**: Every run in which the expected blocker code was not where it should be is diagnosable from the run's timeline alone (repository, blocker, branch, decision), and every such situation that needs a human produces exactly one open task per (ticket, blocker, repository, kind).
- **SC-005**: With the setting unset, the full existing test suite passes unchanged and no observable behaviour differs from the pre-feature system.
- **SC-006**: An operator can configure the feature in a single settings field, with misconfiguration (unknown status name) degrading to today's behaviour plus a visible diagnostic — never a silently dead setting and never a stranded ticket.

## Assumptions

- Blocker tickets whose work matters for inheritance are processed by the system (have runs with reports); work done entirely outside the system yields the documented missing-branch behaviour rather than inheritance.
- The existing artifact-report matching rules (exact repository name, one case-insensitive fallback) are sufficient for blocker reports too; no new matching semantics are introduced.
- One workspace-wide release status is sufficient for v1 (per-agent override explicitly deferred; see Out of scope).
- Jira status names are stable enough to compare by name; storing statuses by id is a known shared weakness (same as agent trigger statuses) to be fixed for both in a separate feature.
- The poller's existing poll fields already include issue links; observing blocked-by keys on every poll adds no Jira API cost.
- Stacked-PR hygiene (opening the dependent's PR against the blocker's branch) is conveyed through wrapper facts; enforcing merge order in the hosting provider is out of scope.

## Out of Scope

- Per-agent release-threshold override (deferred; workspace scope keeps the per-ticket blocked-state cache a single truth).
- A work-stream / integration-branch entity — a chain of stacked PRs already keeps unfinished work out of the default branch.
- New report-schema fields (e.g. base branch, head commit) — the missing-branch asymmetry makes them unnecessary.
- Base-drift detection and auto-rebase when a blocker is reworked or force-pushed after a dependent started — each new run re-resolves its base at prepare; only an in-flight run can be stale.
- Per-chain run serialisation — parallel dependents only read the blocker's branch and each pushes its own; there is no write race.
- Storing Jira statuses by id instead of name (shared weakness with agent trigger statuses; fix both together separately).
- Merge gating / ordering of PR merges in the hosting provider.

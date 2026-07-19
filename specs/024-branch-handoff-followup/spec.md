# Feature Specification: Branch Handoff Follow-Up

**Feature Branch**: `claude/brigadir-023-followup-rop3qc` (feature directory `024-branch-handoff-followup`)

**Created**: 2026-07-19

**Status**: Draft

**Input**: Follow-up work list from feature 023 ("branch handoff between pipeline stages", PR #36): (1) rework/triage handoff prompt sections ignore v2 per-repo artifacts, so a rework agent is never told which branch the prior work lives on; (2) the wrapper still suggests a system-invented branch name `run/<TICKET>` to first stages, conflicting with the spec-kit naming convention the planner actually follows; (3) the 023 design has no deterministic backstop for an agent that pushed commits but reported no artifacts.

## Overview

Feature 023 made the branch handoff between pipeline stages report-driven: an agent pushes its own branch, reports it in `artifacts.repos[].branch`, and the next stage's worktree starts from that branch. Three gaps remain around the *prompt* side of that handoff and its honesty guarantee.

**Gap 1 — the rework/triage prompt never mentions v2 branches (live bug).** The handoff sections that a rework or triage agent receives read only the flat v1 artifact fields (`artifacts.branch` / `artifacts.pr_url`) and bypass the single flat-vs-plural precedence rule every other consumer uses (`normalizeReportArtifacts`, feature 019). This workspace's agents report v2 (`artifacts.repos[]`), so a rework agent is told "Continue on the existing branch/PR" with **no** branch named at all — it must rediscover where the code lives, or worse, start over. The worktree itself is mounted correctly (023 fixed that path); only the prompt is blind.

**Gap 2 — two conflicting branch-name instructions on a first stage.** 023 stopped the system from creating branches but kept it *naming* them: a first stage with no prior branch is told "at main — create `run/ST3-780`", while the planner's own spec-kit workflow creates `016-st3-780-…`. Nobody chose `run/*` — the prefix is a hardcoded fallback (`behavior.branch_prefix ?? 'run'`); `branch_prefix` is unset on every agent and at workspace level. The chain currently holds only because the planner exercises judgment. The user's stated intent: "let the agents do it themselves, the way the planner just did."

**Gap 3 — no backstop for "committed but reported nothing" (the largest residual risk of 023).** If an agent pushes work but returns empty `artifacts`, the next stage silently starts from the default branch, finds nothing, and can report success — the exact false-success failure mode 023's loud-crash rule (D4) exists to prevent, arriving through the front door. The deterministic check is cheap: after the agent process ends, compare each repo's worktree HEAD against the recorded start ref; HEAD moved with no report entry for that repo ⇒ broken handoff.

Out of scope here (unchanged from 023's deferrals): a `run_repo_artifacts` table, branch discovery via `ls-remote`, distinguishing "merged" from "vanished", branch reaping in the shared cache, run leases. The six pre-existing integration-test failures (`runs-cancel-all`, `serve-static`, `dependency-gate`, `sprint-sequencing`, `callback-completion` flake) are also out of scope: they predate 023, require a Docker daemon to reproduce, and are a test-infrastructure debt item, not part of this feature's behavior.

## Clarifications

### Session 2026-07-19

- Q: What happens to the `run/<TICKET>` branch-name suggestion in the wrapper (gap 2)? → A: Drop the suggestion entirely. The wrapper tells a first stage to create a branch of its own choosing and report it; no system-invented name is offered. `branch_prefix` stays in schemas/API/UI as an inert stored field (no migration), but no longer feeds the wrapper.
- Q: When the unreported-work backstop (gap 3) detects moved HEAD with no report entry — fail the run or record an event? → A: Fail the run loudly. An event-only breadcrumb would leave the next stage silently starting from the default branch anyway, reproducing the false-success failure mode with better logging. Consistent with 023's D4: visible crash beats invisible wrong success.
- Q: Where does the backstop check run? The 023 sketch ("compare HEAD before `cleanupWorkspace`, fail the run") cannot be a control: `complete_task` finalizes the run and enqueues the Jira transition at callback time, while the agent process exits later — by exit time the run is already `succeeded`, the ticket has moved, and the rule-7 guard makes a fail a no-op. → A: Gate the completion itself. A `complete_task` whose report omits a repository with locally advanced work is rejected (the run stays active, the agent corrects and re-completes — the same posture as invalid team reports); an agent that ends the session without a valid completion falls into the existing fail-closed path, so the terminal state of an uncorrected violation is a `failed` run with the violation diagnostic on the timeline. A false success is impossible by construction; the run/ticket ordering is never disturbed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A rework agent is told which branch carries the prior work (Priority: P1)

A developer run fails review; the orchestrator routes a rework back to the developer. The rework agent's handoff section names, per repository, the branch (and PR when reported) the failing run produced — for v2 multi-repo reports exactly as it always did for v1 flat reports. The same applies to the triage and answer-triage sections the orchestrator reads when deciding what to do with a failure.

**Why this priority**: This is a live bug in the workspace today: every agent reports v2, so every rework and triage prompt currently renders **no** artifact line at all. The 023 worktree mounting works, but the agent is not told what the system already knows. Fully implementable and testable in this session (pure prompt-assembly logic with unit tests).

**Independent Test**: Build a rework handoff section from a stored failing run whose report contains `artifacts.repos[]`; verify one "Continue on" line per reported repository. Repeat with a v1 flat report; verify the existing rendering is unchanged.

**Acceptance Scenarios**:

1. **Given** a failing run whose report contains `artifacts.repos: [{repo: product, branch: run/T, pr_url: P}, {repo: infra, branch: run/T-infra}]`, **When** the rework handoff section is built, **Then** it contains a continuation line for `product` naming `run/T` and PR `P`, and a line for `infra` naming `run/T-infra`.
2. **Given** a failing run with a v1 flat report (`artifacts.branch`, `artifacts.pr_url`, no `repos`), **When** the rework handoff section is built, **Then** the rendered lines are what they are today (v1 stays valid forever — the schema's forward-compat guarantee).
3. **Given** a failing run whose report has `artifacts.repos: []` or no artifacts at all, **When** the section is built, **Then** no continuation line is rendered and nothing throws (best-effort contract of feature 010 preserved).
4. **Given** a v2 entry with a `pr_url` but no `branch` (or vice versa), **When** the section is built, **Then** the line renders whichever parts exist.
5. **Given** a failing run with v2 artifacts, **When** the triage or answer-triage section is built, **Then** its "Artifacts" block lists each reported repository's branch/PR the same way.
6. **Given** both flat fields and `repos[]` present in one report, **When** any section is built, **Then** only `repos[]` is rendered (the plural form is authoritative — same precedence as every other consumer, never double-rendered).

---

### User Story 2 - A first stage names its own branch without a competing system suggestion (Priority: P2)

A ticket enters the pipeline; the first (planning) stage has no prior branch to continue. The wrapper tells the agent to create a branch of its own choosing and report it — it no longer proposes `run/<TICKET>` or any other system-invented name. Later stages are unaffected (they continue reported branches, where no suggestion was ever made).

**Why this priority**: Removes a standing contradiction — the system says "create `run/ST3-780`" while the agent's own workflow (spec-kit) creates `016-st3-780-…` — that today is resolved only by the agent ignoring the system. Small, self-contained, but it changes the wrapper contract, so it rides behind the P1 bug fix.

**Independent Test**: Build the wrapper for a run with no continuation branch; verify the repo line instructs the agent to create and report a branch and contains no suggested branch name. Verify stored `branch_prefix` values continue to load, persist, and round-trip through the API and settings screen unchanged.

**Acceptance Scenarios**:

1. **Given** a first stage with no prior reported branch, **When** the wrapper is built, **Then** the repo instruction says to create a branch and report it, and contains no system-proposed branch name.
2. **Given** a stage continuing a reported branch, **When** the wrapper is built, **Then** its continuation instruction is byte-identical to today's (this story touches only the "no prior branch" path).
3. **Given** an agent or workspace with `branch_prefix` set in stored config, **When** configs are loaded, listed, or edited via the API/UI, **Then** the field still validates, persists, and returns as before — it is inert, not removed (no migration, no breakage of stored configs).

---

### User Story 3 - Work the agent pushed but did not report fails the run instead of vanishing (Priority: P3)

A developer agent commits work in a repository, then tries to finish with a report that has no artifact entry for that repository (empty `artifacts`, or `repos[]` missing that repo). Instead of letting that completion stand — and the next stage silently start from the default branch and "succeed" on an empty diff — the system detects, deterministically from the worktree state it already holds, that the agent did work it did not report, and refuses the completion with a message naming the repository. The run stays active so the agent can correct the report (push and name the branch) and complete again; an agent that ends its session without a valid completion becomes a `failed` run through the existing fail-closed path, with the violation recorded on the run's timeline. Either way a false success is impossible.

**Why this priority**: Deferred from 023 as its "largest residual risk"; promotes the honesty of the handoff from "we asked the model nicely in the wrapper" to a deterministic check. P3 because it extends the completion contract (the riskiest of the three to get wrong) — the check gates `complete_task` itself, since by process-exit time the run is already finalized and the ticket transition already enqueued (see Clarifications).

**Independent Test**: Submit a completion for a run whose worktree HEAD moved past the recorded start commit in a repo absent from the report; verify the completion is rejected with a diagnostic naming that repo and the run stays active. Submit a corrected report naming the branch; verify it is accepted. Submit reports for unmoved-HEAD and matching-entry cases; verify no interference.

**Acceptance Scenarios**:

1. **Given** a run whose worktree HEAD in repo R has moved past R's recorded start commit, **When** the agent completes with a report carrying no artifact entry for R, **Then** the completion is rejected with a diagnostic naming R and both commits, the run stays active, and the violation is durably recorded on the run's timeline.
2. **Given** the same run, **When** the agent corrects the report to include an entry for R and completes again, **Then** the completion is accepted and the run finalizes normally.
3. **Given** a rejected completion, **When** the agent ends its session without a further valid completion, **Then** the run becomes `failed` through the existing exit-without-completion path, and the recorded violation explains why on the timeline.
4. **Given** HEAD moved in R **and** the report carries an artifact entry for R, **When** the agent completes, **Then** the completion is accepted (reported work is the expected case).
5. **Given** HEAD did not move in any repo and the report names no artifacts, **When** the agent completes, **Then** the completion is accepted (a read-only stage — reviewer, triage — legitimately reports no artifacts).
6. **Given** the worktree evidence is unavailable (a run with no mounted repositories, a start record that was never written, or the local state cannot be read), **When** the agent completes, **Then** the check degrades silently and the completion proceeds — absence of evidence must never create false rejections.
7. **Given** a run parked `awaiting_human` (agent exits legitimately via a blocking question, no completion submitted), **When** the process ends, **Then** the backstop does not fire (nothing was completed; prior work is picked up on resume).

---

### Edge Cases

- A v2 report entry names a repository not mounted in the run (feature 020 self-clone): its line still renders in the handoff prompt — rendering is verbatim-after-scrubbing (feature 019 rule); only worktree mounting does strict matching.
- More repos reported than mounted, or `repos[]` at its schema cap (20): every entry renders; the per-field truncation budgets keep the section bounded.
- `branch_prefix` set on an agent after this feature ships: the value persists but produces no wrapper suggestion — settings UI keeps accepting it (inert by decision, no migration).
- Backstop vs. amended commits / force-push: HEAD "moved" means `HEAD != start ref`, not ancestry — an agent that amended in place still counts as having done unreported work.
- Backstop when the start ref record itself is missing (e.g. run predates 023, or the event write failed): degrade silently — no evidence, no failure.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The rework handoff section MUST render one continuation line per repository artifact the failing run reported, including the repository name (when the report carries one), the branch, and the PR URL — whichever are present.
- **FR-002**: The triage and answer-triage handoff sections MUST render their artifacts block from the same per-repository data, one line per reported repository.
- **FR-003**: All handoff artifact rendering MUST derive from the single existing flat-vs-plural precedence rule (`normalizeReportArtifacts`, feature 019) — no site may re-implement the precedence; when `repos[]` is present the flat fields are ignored, never double-rendered.
- **FR-004**: v1 flat reports MUST keep rendering as they do today; existing v1 assertions stay green (schema forward-compat guarantee: v1 stays valid forever).
- **FR-005**: Handoff assembly MUST remain best-effort and size-bounded (feature 010 contract): missing or empty artifact data degrades to no line, never throws, never fails the run; free text keeps its truncation budgets.
- **FR-006**: The wrapper MUST NOT propose a system-invented branch name to a stage that has no continuation branch; it MUST instruct the agent to create a branch of its own choosing and report it. The continuation-branch instruction path is unchanged.
- **FR-007**: `branch_prefix` MUST remain valid in stored agent/workspace configuration, API responses, and the settings UI (inert field, no migration); it MUST no longer influence wrapper content.
- **FR-008**: A completion whose report omits an artifact entry for a repository whose worktree HEAD differs from that repository's recorded start commit MUST be rejected before the run finalizes: the run stays active, the agent receives a diagnostic naming the repository and both commits, and the violation is durably recorded on the run's timeline. An uncorrected violation ends as a `failed` run via the existing exit-without-completion path — never as a success.
- **FR-009**: The backstop MUST NOT reject when the report carries an artifact entry for every moved repository, when no HEAD moved, or when the evidence is unavailable (no mounted repositories, missing start record, unreadable local state) — absence of evidence degrades silently to the current behavior. The check MUST NOT alter run/ticket ordering: an accepted completion finalizes exactly as today, and no state written after finalization may be clobbered (hard-won rule 7 untouched).
- **FR-010**: All three behaviors MUST ship with automated tests in the same change (Constitution VI — this is pipeline logic): prompt-assembly unit tests for FR-001..005, wrapper tests for FR-006..007, and executor-lifecycle tests for FR-008..009.

### Key Entities

- **Agent report artifacts**: the failing run's stored report; v1 flat form (`branch`/`pr_url`) or v2 per-repo list (`repos[]: {repo, branch, pr_url, …}`); the plural form is authoritative when present.
- **Handoff section**: the ephemeral prompt block (rework / triage / answer-triage) assembled at run start; never persisted; best-effort and size-bounded.
- **Wrapper repo instruction**: the per-repository text telling an agent whether to continue a named branch or create its own.
- **Start-ref record**: the per-repo `start-ref` run-timeline entry written by 023 — the durable record of where each mounted repo began; the backstop's baseline.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a workspace whose agents report v2 artifacts, 100% of rework and triage handoff prompts built from a failing run that reported branches name every reported branch (today: 0% — no line renders at all).
- **SC-002**: Zero change in rendering for v1 flat reports — all pre-existing handoff assertions pass unmodified.
- **SC-003**: A first stage receives exactly one branch-naming instruction (its own workflow's), not two conflicting ones; no system-proposed branch name appears in any wrapper.
- **SC-004**: Zero stored-configuration breakage: every existing agent/workspace config with `branch_prefix` set loads and round-trips unchanged.
- **SC-005**: A run with locally advanced work and no artifact entry for that repository can never finish `succeeded`: its completion is rejected with a diagnostic naming the repository, and it ends either with a corrected report or as `failed`. Read-only runs (no local changes, no artifacts) are unaffected.

## Assumptions

- The three work items ship as one feature (independently testable stories) on the branch this session was assigned; priority order 1→2→3 mirrors the handoff's ordering.
- The pre-existing integration-test failures (item 4 of the handoff) are excluded: they predate 023, need a Docker daemon (unavailable in this session), and belong to a separate maintenance effort.
- `branch_prefix` is kept as an inert stored field rather than removed, to avoid schema/API migrations (per the accepted option (a)).
- The backstop compares exact commits (`HEAD != recorded start commit`), using only local state already in hand at completion time — no new network calls, no `ls-remote` discovery (still out of scope per 023).
- End-to-end verification against a live pipeline (real Jira, real agent runs) cannot happen in this session and is handed back to the user's stand; unit/contract coverage is the in-session verification bar.

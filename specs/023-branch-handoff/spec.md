# Feature Specification: Branch Handoff Between Pipeline Stages

**Feature Branch**: `claude/reviewer-agent-failure-aea7e1` (feature directory `023-branch-handoff`)

**Created**: 2026-07-18

**Status**: Implemented

**Input**: Live failure on ST3-780 — the reviewer stage crashed before its agent started, with `repo "st3_agentic": branch "run/ST3-780" already exists with 2 commit(s) of prior work — refusing to discard or silently reuse it`.

## Overview

The system pre-created one branch per run, named `<branch_prefix>/<ticket_key>`, and guarded it: a branch that already carried commits failed the run loudly rather than being reused or discarded (a policy born of the 2026-07-14 incident, where prior work was silently thrown away). Permission to reuse the branch was granted on exactly one signal — the run's trigger source being `human-resume` or `rework`.

A normal stage handoff carries neither source. When the planner finishes, the system transitions the ticket, the poller observes the new status, and it dispatches the next agent with `source: 'poll'`. To the guard that looks identical to someone starting the ticket from scratch, so it refuses the branch the previous stage just committed to.

The result was not intermittent: **the first stage that commits to the run branch succeeds, and every stage after it fails, always.** On ST3-780 the planner escaped only because spec-kit moved it onto its own branch (`016-st3-780-…`), which the developer then merged by hand — the chain held together through an instruction to the agent, not through system mechanics.

This feature removes the system from the branch namespace entirely. Agents already commit and push their own work (the codebase contains no `git commit` or `git push`) and already report the branch they used in `artifacts.repos[].branch`. The system now reads that report and starts the next stage from the branch the previous one named. A naming convention is replaced by an explicit, recorded handoff.

## Clarifications

### Session 2026-07-18

- Q: Should the system keep creating a branch and only fix the reuse rule? → A: No. Creating a branch buys nothing — the agent has a writable worktree either way — while forcing the system to defend a name it invented. The worktree is checked out DETACHED at a resolved start ref; naming and pushing belong to the agent.
- Q: Report-driven or discovered from git (e.g. globbing origin for refs containing the ticket key)? → A: Report-driven, verified against git. Discovery would reintroduce a naming convention as load-bearing and, on ST3-780's own shape (two refs mentioning the ticket), would be ambiguous exactly when it matters. The report disambiguates; origin verifies.
- Q: What happens when a reported branch is not on origin? → A: The run fails loudly. Falling back to the default branch would let a reviewer review an empty diff and report success — a false success is strictly worse than a visible crash in an autonomous pipeline.
- Q: What about a repo with no reported branch? → A: Start from its default branch, silently. The asymmetry between "explicitly named but missing" (crash) and "not named" (default) is the core rule.
- Q: Does `branch_prefix` disappear? → A: No. It stops being an instruction to git and becomes the name SUGGESTED to the agent in the wrapper, so every stored config, settings screen and API response keeps working unmigrated.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A pipeline stage continues the previous stage's work (Priority: P1)

A planner writes the plan and pushes it. A developer implements on top and pushes. A reviewer opens the same code the developer wrote. No human deletes a branch, merges anything by hand, or re-triggers a stage as "rework" to make the chain work.

**Why this priority**: This is the bug. Without it, multi-stage pipelines — the product's premise — cannot complete a single ticket.

**Independent Test**: Complete a stage that pushes a branch and reports it, then dispatch the next stage on the same ticket with trigger source `poll`. Verify the run starts, and that its worktree HEAD is the previous stage's commit.

**Acceptance Scenarios**:

1. **Given** a prior successful run on the ticket reporting `{repo: product, branch: run/T}` and that branch present on origin, **When** the next stage is dispatched by the poller, **Then** the run starts with `product` detached at that branch's tip.
2. **Given** the same setup, **When** the agent reads its wrapper, **Then** it is told `continue branch run/T` and instructed to build on it rather than start a competing branch.
3. **Given** no prior run reported anything for the ticket, **When** a stage is dispatched, **Then** every repo starts from its own default branch and the run proceeds normally.
4. **Given** a prior run that reported a branch for `product` only, **When** the next stage mounts `product` and `infra`, **Then** `product` continues its branch and `infra` starts from its default branch.
5. **Given** a resume or rework naming a specific failing run, **When** that run reported a branch, **Then** it is preferred over any newer successful run.
6. **Given** a resume naming a run that died before reporting, **When** the successor starts, **Then** it falls through to the latest successful run's branch rather than to the default branch.

---

### User Story 2 - A broken handoff fails loudly instead of silently reviewing nothing (Priority: P1)

A stage reports a branch it never pushed, or the branch is deleted between stages. The next stage refuses to run rather than quietly starting from the default branch and reporting success on an empty diff.

**Why this priority**: The failure mode this prevents is the worst outcome an autonomous pipeline can produce — a confident success that reviewed nothing. It ships with Story 1 or Story 1 is unsafe.

**Independent Test**: Report a branch that was never pushed, dispatch the next stage, and verify the run fails with a message naming the repo and the branch.

**Acceptance Scenarios**:

1. **Given** a prior report naming a branch absent from origin, **When** the next stage prepares, **Then** the run fails with `repo "<name>": previous run reported branch "<b>" but origin has no such branch`.
2. **Given** a branch deleted upstream after a previous run already warmed the repo cache, **When** the next stage prepares, **Then** it still fails — a stale remote-tracking ref never resurrects a deleted branch.
3. **Given** a reported branch name that is not a valid git branch name (or begins with `-`), **When** the next stage prepares, **Then** it is rejected before any git command consumes it.
4. **Given** a multi-repo run where the second repo's reported branch is missing, **When** prepare fails, **Then** the first repo's worktree is unwound and the parent dir removed.

---

### User Story 3 - An operator can tell where a stage started, and why (Priority: P2)

Opening a run, an operator sees per repository which ref it started from and what decided it — without reading logs.

**Why this priority**: The handoff is now data-driven, so "it started from the wrong place" becomes a diagnosable question. Story 1 works without this; trusting it over time does not.

**Independent Test**: Run a stage with and without prior work and verify each case records a per-repo timeline entry naming the decision.

**Acceptance Scenarios**:

1. **Given** a stage continuing a reported branch, **When** an operator inspects the run, **Then** a `start-ref` entry per repo names the branch and the run that reported it, with decision `report_confirmed`.
2. **Given** a stage with no prior work, **When** an operator inspects the run, **Then** the entry records decision `default_branch` — the boring case is recorded too.
3. **Given** a report naming a repository this run did not mount, **When** the stage runs, **Then** the unmatched name is surfaced on the entry and the run is not failed by it.

## Requirements *(mandatory)*

- **FR-001**: The system MUST NOT create, delete, reset or force-update any git branch. Worktrees are checked out detached at a resolved start ref.
- **FR-002**: A run's start ref per repository MUST resolve as: the branch reported by the run named in `trigger_event.failing_run_id` (any status), else the branch reported by the latest `succeeded` run on the ticket, else `origin/<defaultBranch>`.
- **FR-003**: A run named by `failing_run_id` that reported no branch MUST fall through to the latest successful run rather than to the default branch.
- **FR-004**: A branch named by a report MUST be verified present on `refs/remotes/origin/*` before use; a miss MUST fail the run loudly and MUST NOT fall back to the default branch.
- **FR-005**: The repository cache fetch MUST prune deleted remote-tracking refs, so a deleted branch cannot be resolved from a stale ref.
- **FR-006**: A reported branch name MUST be validated (rejecting leading `-` and anything `git check-ref-format --branch` refuses) before reaching any git argv.
- **FR-007**: Matching reported repo names to mounted repositories MUST be exact, then case-insensitive, and nothing further. The flat v1 artifact form (no repo name) applies only when exactly one repository is mounted.
- **FR-008**: A reported repository name matching nothing mounted MUST be recorded, not fail the run.
- **FR-009**: The wrapper MUST tell the agent that its worktree is detached, which branch to continue or create, that it must branch before its first commit, and that the next stage starts from what it reports.
- **FR-010**: `branch_prefix` MUST remain a valid, stored configuration value, applied as the suggested branch name; no config migration is required.
- **FR-011**: Each mounted repository MUST get one `start-ref` timeline entry recording the repo, the decision, the continue branch (or null), and the reporting run.
- **FR-012**: Ticketless workspace-setup runs MUST NOT resolve prior work; they suggest `setup/<runId8>` and start from the default branch.

### Out of Scope

- Detecting that an agent committed work but failed to report it (see Deferred below — the largest residual risk).
- A first-class `run_repo_artifacts` table, and distinguishing "branch merged" from "branch vanished" (needs a persisted SHA).
- Discovering branches from origin when a report is absent.
- A per-workspace feature flag and staged rollout.
- Reaping accumulated agent branches from the shared repo cache; leases preventing two concurrent runs on one ticket.
- The pre-existing v2 gap in `handoff.ts`, where rework/triage handoff sections read only the flat artifact form and render no `Continue on:` line for multi-repo reports.

## Success Criteria *(mandatory)*

- **SC-001**: A ticket completes planner → developer → reviewer with zero human git intervention and zero `rework` re-triggers.
- **SC-002**: A stage whose predecessor's branch is missing from origin fails visibly; no run reports success having started from an unintended ref.
- **SC-003**: For any run, the ref each repository started from and the reason are answerable from the run timeline alone.
- **SC-004**: Existing workspaces and agents keep working with no config or data migration.

## Supersedes

- `specs/019-multi-repo-runs/` research D3/D4 and the leftover-branch policy: the single shared `<branchPrefix>/<ticketKey>` branch across repos, the zero-commit reclaim, the with-commits fail-loud guard, and `reuseBranch`.
- The `isResumedAttempt` field on `RunContext` (feature 004 FR-016/018 as *implemented*; those requirements themselves concern attempt counting and answer injection and are unaffected).

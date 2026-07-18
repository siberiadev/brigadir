# Feature Specification: Multi-Repository Runs

**Feature Branch**: `claude/multi-repo-runs-pdobzd`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Multi-repository runs — give an agent all of its workspace's repositories in a single run. A run prepares worktrees for all repositories available to the agent, the agent's working directory is a parent directory containing one sub-worktree per repo, and the agent decides from the ticket text which repositories actually need changes. Delivery (branch push / PR) and reporting happen per touched repo. Legacy single-repo agents keep behaving exactly as before."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A cross-repository ticket is completed in a single run (Priority: P1)

A ticket requires coupled changes across several repositories — e.g., a contract change in a shared library plus corresponding updates in its consumers. Today the operator must split this into one ticket per repository and manually shuttle context between sequential runs. With this feature, the agent's run workspace contains one working copy per repository the agent has access to, all on the same ticket-named branch. The agent reads the ticket, decides which repositories actually need changes, makes commits only in those, delivers (branch push / pull request) per changed repository, and reports one artifact entry per changed repository. Untouched repositories cost almost nothing to include and leave no lasting traces.

**Why this priority**: This is the entire point of the feature — removing the human coordination overhead of cross-repo tickets, which is exactly the class of overhead BRIGADIR exists to eliminate. Every other story is either compatibility protection or configuration convenience around this capability.

**Independent Test**: Configure an agent with two repositories, trigger a run on a ticket whose changes belong in only one of them, and verify: both working copies exist on the same ticket branch during the run; commits and delivery happen only in the changed repository; the run report carries exactly one per-repository artifact entry; the untouched repository gets no push and no PR.

**Acceptance Scenarios**:

1. **Given** an agent with two declared repositories and a ticket `TICKET-123`, **When** a run starts, **Then** the run's workspace is a parent directory containing one sub-working-copy per repository, each checked out on the same branch named after the ticket (e.g., `feat/TICKET-123`), and the run's recorded workspace path points at the parent directory.
2. **Given** that run's workspace, **When** the agent commits in only one of the two repositories and completes the run, **Then** the run report contains exactly one entry in the per-repository artifacts list (repository name, branch, PR link if any, commits, files changed) and delivery (branch push / pull request) happens only for that repository.
3. **Given** a completed multi-repo run with one changed repository, **When** the next run for the same ticket branch starts, **Then** the untouched repository's zero-commit leftover branch is silently deleted and recreated (existing leftover policy), while a leftover branch WITH commits in any repository causes the run to fail loudly for a human to decide.
4. **Given** the agent changed two repositories whose changes depend on each other, **When** pull requests are created, **Then** each PR's description references the dependent PR(s) in the other repository (the agent is instructed to cross-link them).
5. **Given** a multi-repo run completed with per-repository artifacts, **When** the operator looks at the ticket's Jira comment and the run's dashboard checklist, **Then** both render one artifact line per changed repository (branch, PR link, commit/file counts).
6. **Given** required checks / test verification are configured for the agent, **When** the run completes, **Then** checks and tests were executed only in the repositories the agent actually changed.

---

### User Story 2 - Existing single-repository agents behave exactly as before (Priority: P2)

An operator with agents configured the old way — a single repository name on the agent's behavior — upgrades to this version. Nothing changes for them: runs prepare the same single working copy semantics, reports keep validating, Jira comments and the dashboard render the same information, and no stored agent configuration needs to be edited or migrated.

**Why this priority**: This is a running production tool; a compatibility break would stop every existing workspace. The feature is only shippable if legacy configurations are bit-compatible in observable behavior.

**Independent Test**: Take an agent configured with the deprecated single-repository field, run it on a ticket, and verify the run behaves identically to the pre-feature behavior: one working copy, one branch, flat report artifact fields accepted, identical Jira comment and dashboard rendering, no configuration rewrite required.

**Acceptance Scenarios**:

1. **Given** a stored agent with the deprecated single-repository setting (e.g., `repository: "product"`), **When** a run executes, **Then** the run operates on exactly that repository, treated as a one-element repository list, with no change in delivery, reporting, or rendering visible to the operator.
2. **Given** stored agent rows created before this feature, **When** the system starts and loads them, **Then** they validate without any rewriting or migration of stored configuration.
3. **Given** a run report using the existing flat artifact fields (branch, PR link, commits, files changed) without the new per-repository list, **When** the report is submitted, **Then** it validates and is processed, rendered in Jira, and shown on the dashboard exactly as today.
4. **Given** a ticketless workspace-setup run, **When** it starts, **Then** its branch identity (`setup/<short run id>`) and repository behavior keep working unchanged.

---

### User Story 3 - Operator scopes an agent to a subset of workspace repositories (Priority: P3)

An operator declares which of the workspace's repositories a given agent works with, using a list on the agent's behavior. Leaving the list empty or absent means "all workspace repositories". A typo — a name that doesn't match any declared workspace repository — is rejected at configuration validation time with a field-level error, not discovered at run time.

**Why this priority**: Scoping is a convenience and safety refinement on top of Story 1; the feature is viable with all-repositories-by-default alone.

**Independent Test**: Configure an agent with a repository list naming a subset of the workspace's repositories, run it, and verify only those repositories are prepared; then configure a list containing an unknown name and verify validation rejects it with a pointer to the offending entry.

**Acceptance Scenarios**:

1. **Given** a workspace with three repositories and an agent whose repository list names two of them, **When** a run starts, **Then** exactly those two repositories are prepared in the run workspace.
2. **Given** an agent with no repository list (and no deprecated single-repository setting), **When** a run starts, **Then** all workspace repositories are prepared.
3. **Given** an agent configuration whose repository list contains a name not declared among the workspace's repositories, **When** the configuration is validated, **Then** validation fails with an error identifying the offending list entry (same behavior as the existing single-repository reference check).

---

### Edge Cases

- **Partial preparation failure**: if preparing the working copy for repository N of M fails (clone/fetch error, leftover branch with commits), the working copies already created for that run MUST be cleaned up before the run is failed — no orphaned half-prepared workspaces.
- **Leftover branch WITH commits in any one repository**: the whole preparation fails loudly (existing per-repo policy, applied per repository); a human decides. Zero-commit leftovers in any repository are deleted and recreated silently.
- **Agent changes no repository at all**: the run may still complete (e.g., analysis-only outcome); the per-repository artifacts list is empty or absent, no delivery occurs anywhere, and no checks/tests are run.
- **Both new list and deprecated single-repository field present** on one agent: the list takes precedence; the deprecated field is ignored (documented in Assumptions).
- **Failed-run inspection**: when failed workspaces are kept for inspection, the whole parent directory (all sub-working-copies) is kept, and the run's recorded workspace path leads the operator to it.
- **Report contains both flat artifact fields and the per-repository list**: the per-repository list is authoritative; flat fields are tolerated as the legacy single-repo form.
- **Repository-less agents and workspaces** (e.g., orchestrator triage runs, workspaces with no repositories): behave exactly as today — no working copy at all is prepared.
- **Duplicate or filesystem-unsafe repository names**: repository names already serve as per-repository cache directory names today; the same uniqueness/safety constraints apply unchanged and no new naming rules are introduced.

## Requirements *(mandatory)*

### Functional Requirements

**Block 1 — Agent repository scope (configuration contract)**

- **FR-001**: An agent's behavior MUST accept a list of repository names (`repositories`) designating the subset of the workspace's declared repositories the agent works with. An empty or absent list means ALL workspace repositories.
- **FR-002**: The deprecated single-repository behavior field (`repository`) MUST remain valid, interpreted as a one-element repository list, following the same deprecated-field pattern already used for the workspace's legacy single-repo fields. Stored agent rows MUST NOT require rewriting or migration. If both the list and the deprecated field are present, the list wins.
- **FR-003**: Configuration validation MUST verify cross-field that every name in the agent's repository list references a repository declared on the workspace, reporting a field-level error path for each unknown name (mirroring the existing single-repository reference check).
- **FR-004**: The repository-scope resolution MUST use the same repository source of truth and fallback order as today (workspace settings first, YAML config as fallback for YAML-imported setups).

**Block 2 — Run workspace preparation**

- **FR-005**: A run for a repository-carrying agent MUST prepare one working copy per repository in the agent's resolved scope, laid out as `worktreeRoot/<runId>/<repo name>/`, with the agent's working directory set to the parent `worktreeRoot/<runId>/` directory. The run's recorded workspace path (`runs.worktree_path`) MUST point at the parent directory, and the run's instruction wrapper file MUST land in the parent directory.
- **FR-006**: Every prepared working copy in a run MUST be on the same branch, named `<branch prefix>/<ticket key>`, preserving branch↔ticket traceability across repositories. Ticketless setup runs keep their existing `setup/<short run id>` branch identity.
- **FR-007**: The existing leftover-branch policy MUST apply per repository, unchanged: a pre-existing branch with zero commits beyond its base is deleted and recreated; a pre-existing branch with commits fails preparation loudly for a human to resolve.
- **FR-008**: If preparation fails partway through the repository list, the working copies already created for that run MUST be cleaned up before the failure is surfaced; run cleanup (success and failure paths, including the keep-failed-workspaces inspection option) MUST operate on the whole parent directory.
- **FR-009**: Preparing repositories the agent ends up not touching MUST remain cheap: the existing per-repository clone cache is reused, and no delivery, checks, or lasting branches result from an untouched repository (its zero-commit leftover is reclaimed by FR-007 on the next run).

**Block 3 — Per-repository reporting**

- **FR-010**: The run report contract MUST gain a per-repository artifacts list — for each repository: repository name, branch, PR link (optional), commit list, and files-changed count — while the existing flat single-repo artifact fields remain valid for back-compat. The report schema version MUST be bumped, and the change MUST be forward-compatible per the established report-versioning rules.
- **FR-011**: When both forms appear in one report, the per-repository list is authoritative; a legacy flat-only report is processed exactly as today.
- **FR-012**: Backend report validation, the secret scrubber, the Jira comment rendering, and the dashboard run checklist MUST all handle the per-repository form, rendering one artifact line per reported repository; legacy flat reports keep rendering unchanged.

**Block 4 — Agent guidance, delivery, and checks**

- **FR-013**: The run instruction wrapper MUST list every prepared repository with its absolute path and default branch, and MUST instruct the agent to: (a) determine from the ticket which repositories need changes; (b) commit and push only in repositories it actually changed; (c) cross-reference dependent PRs between repositories in each PR description; (d) report artifacts per repository when completing the task.
- **FR-014**: Code delivery (branch push / pull request, per the agent's configured delivery mode) MUST apply per changed repository — one branch/PR per repository the agent touched, none for untouched repositories.
- **FR-015**: Required checks and test verification MUST run only in the repositories the agent actually changed ("changed" = at least one commit beyond the base branch in that repository's working copy).

**Cross-cutting**

- **FR-016**: All new pipeline-path logic (scope resolution and validation, multi-repository preparation/cleanup, wrapper content, report validation and rendering) MUST ship with automated tests in the same change: unit tests for the contract, preparation, and wrapper changes, plus integration tests against real infrastructure extending the existing repository-run integration suite (Constitution VI).
- **FR-017**: No database schema change is expected (repository scope lives in agent settings, reports in the report document); if one becomes necessary it requires updating the architecture document first. The architecture document's report contract, wrapper, and runtime-preparation sections and the progress journal MUST be updated in the same iteration.

### Key Entities

- **Agent repository scope**: the set of workspace repositories a given agent operates on — an explicit name list, a deprecated single name (one-element list), or absent (all workspace repositories). Stored with the agent's behavior settings; validated against the workspace's declared repositories.
- **Run workspace (multi-repo)**: the parent directory a run works in, containing one sub-working-copy per in-scope repository, all on the same ticket-named branch; the unit of cleanup, failure-inspection retention, and the location of the run's instruction wrapper.
- **Per-repository artifact**: one entry in the run report's artifacts list describing what the run produced in a single repository — repository name, branch, optional PR link, commits, files-changed count. Rendered as one line each in the Jira comment and dashboard checklist.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A ticket requiring coordinated changes in two repositories completes in ONE run with zero human context-shuttling between repositories (today: at least two sequential single-repo tickets plus manual coordination).
- **SC-002**: 100% of pre-existing single-repository agent configurations run without any stored-configuration edit, and their runs' observable outputs (delivery, report processing, Jira comment, dashboard) are unchanged.
- **SC-003**: Untouched repositories leave no lasting artifacts: no pushes, no PRs, no checks executed, and any zero-commit leftover branch is reclaimed automatically by the next run — 0 human cleanup actions required.
- **SC-004**: For every multi-repository run that changed N repositories, the ticket's Jira comment and the run's dashboard checklist each show exactly N per-repository artifact lines.
- **SC-005**: With warm per-repository caches, adding a repository to a run's scope adds only seconds to run startup (working-copy creation from cache), not a full clone's worth of time.
- **SC-006**: A preparation failure on any repository leaves zero orphaned working copies for that run (verified by inspecting the workspace root after induced failures).

## Assumptions

- **"Changed/touched repository"** means: at least one commit beyond the base branch exists in that repository's working copy at run completion. This is the trigger for delivery, checks, and a per-repository artifact entry.
- **Precedence of scope fields**: when an agent has both the new repository list and the deprecated single-repository field, the list wins and the deprecated field is ignored (no validation error — stored legacy rows plus a later list edit must coexist).
- **Report precedence**: a report carrying the per-repository list is authoritative for artifacts; flat fields in the same report are tolerated as a legacy duplicate and not double-rendered.
- **Repository naming**: workspace repository names are already used as cache directory names, so they are assumed unique and filesystem-safe; no new naming constraints are introduced.
- **Setup runs**: ticketless workspace-setup runs keep their current repository behavior (workspace default repository, `setup/<short run id>` branch, local-only, never pushes); this feature must not regress them, and widening their scope is not required.
- **No new run-parallelism semantics**: one run still executes one agent process; multi-repo only widens the workspace, not concurrency, queueing, or idempotency behavior (the three dedup layers are untouched).
- **Same-branch-name convention** across repositories is acceptable to the team (it is the traceability mechanism; per-repo branch naming is not needed).

## Out of Scope

- **Cross-repository atomic merges** — impossible with separate PRs per repository; PR cross-references are the coordination mechanism.
- **Inferring the repository subset from Jira labels/components** — future optimization; scope comes only from agent configuration in this feature.
- **Changes to reconciliation, the trigger-event contract, or the Jira write queue** — explicitly untouched.
- **Reading the Jira "linked to" field** — not consulted for repository selection or anything else.

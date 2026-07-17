# Feature Specification: Agent Role & Executor Visibility in Dashboard Lists

**Feature Branch**: `claude/speckit-dashboard-ui-polish-isgpuf`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "UI polish: agent role and executor visibility, human queue ordering. Four small improvements to existing dashboard pages: (1) Runs list (workspace page, /:id/runs tab): add a 'Role' column showing the run's agent role (the agent reference in the runs list API response already carries `role`). Runs whose agent has no role show an em dash. No backend changes expected. (2) Agents page (workspace /:id/agents tab): today the agent's role is rendered inline next to the name as 'Name (role)'. Split it out: the Name column shows only the persona name, and a new 'Role' column shows the role inside an el-tag. Agents without a role show nothing (empty cell). Keep the existing Key column as is. (3) Agents page: add an 'Executor' column showing the agent's executor PROFILE NAME (not the raw executor_id UUID). The agent response only carries executor_id, so the name must be resolved against the platform executors list. If a profile cannot be resolved, fall back to showing nothing. Constraints: follow existing UI conventions — brand colors only via --el-color-* variables, no custom pagination, lucide icons static outside the sidebar. Frontend tests for the new columns and ordering belong to the same iteration."

**Scope note**: The original title mentioned "human queue ordering" as a fourth item, but no change was described. Clarified with the requester on 2026-07-17: the human queue is **out of scope** — this feature covers only the three column improvements below. The open human queue already sorts oldest-first on the server; no change or extra test is requested.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the agent's role on each run (Priority: P1)

An operator scanning a workspace's Runs tab wants to know *what kind* of agent handled each run (Developer, QA, Reviewer, teamlead) without recognizing every persona name. Since feature 014, agents carry a themed persona name ("Hera") plus a functional role ("Reviewer") — but the Runs list shows only the persona name, so a run by "Hera" is opaque to anyone who doesn't know the team roster by heart.

**Why this priority**: The Runs list is the most-visited operational view; the role is the single missing piece of context that makes a run's row self-explanatory. The data is already delivered to the browser — this is pure presentation.

**Independent Test**: Open a workspace's Runs tab with runs from a role-bearing agent and a role-less agent; verify the new Role column shows the role for the first and an em dash for the second. Deliverable on its own.

**Acceptance Scenarios**:

1. **Given** a workspace with a run whose agent has role "Reviewer", **When** the operator opens the Runs tab, **Then** the run's row shows "Reviewer" in a Role column alongside the agent's name.
2. **Given** a run whose agent has no role, **When** the Runs list renders, **Then** that row's Role cell shows an em dash ("—").
3. **Given** the existing Runs list columns (Agent, Ticket, Status, Attempt, Duration, Cost), **When** the Role column is added, **Then** all existing columns, filters, row-click navigation, and pagination keep working unchanged.

---

### User Story 2 - Role as its own column on the Agents page (Priority: P2)

An operator reviewing a workspace's team on the Agents tab currently reads the role squeezed into the Name column as "Hera (Reviewer)". They want the persona name and the function visually separated so the roster scans like a team sheet: names in one column, roles in another, each role rendered as a distinct tag.

**Why this priority**: Improves scanability of an existing page but the information is already visible today (inline) — lower urgency than surfacing information that is entirely absent (US1).

**Independent Test**: Open the Agents tab of a workspace whose roster mixes role-bearing and role-less agents; verify names render bare, roles render as tags in their own column, and role-less agents have an empty Role cell.

**Acceptance Scenarios**:

1. **Given** an agent named "Hera" with role "Reviewer", **When** the Agents tab renders, **Then** the Name column shows exactly "Hera" (no parenthesized suffix) and a Role column shows "Reviewer" as a tag.
2. **Given** an agent without a role, **When** the Agents tab renders, **Then** its Role cell is empty (no tag, no placeholder text).
3. **Given** the existing Key column, **When** the Role column is added, **Then** the Key column is unchanged in content and presentation.
4. **Given** the orchestrator agent (role "teamlead"), **When** the Agents tab renders, **Then** its role tag renders the same way as any worker agent's.

---

### User Story 3 - Executor profile name on the Agents page (Priority: P3)

An operator on the Agents tab wants to see which executor profile each agent is bound to (e.g. "claude-cli-default") without opening the agent's edit form. The agent record only references the executor by internal id, so the list must show the human-readable profile name resolved from the platform's executor profiles.

**Why this priority**: Valuable for diagnosing misconfigured teams, but the information is reachable today via the edit form — it's a convenience, and it depends on cross-referencing a second data set, making it the most involved of the three items.

**Independent Test**: Open the Agents tab where agents are bound to known executor profiles; verify each row shows the profile's name, and a row whose executor cannot be resolved shows an empty cell.

**Acceptance Scenarios**:

1. **Given** an agent bound to an executor profile named "claude-cli-default", **When** the Agents tab renders, **Then** its Executor cell shows "claude-cli-default", not the internal id.
2. **Given** an agent whose executor reference cannot be resolved against the platform executor profiles (deleted profile, list not yet loaded), **When** the Agents tab renders, **Then** its Executor cell is empty — the raw internal id is never displayed.
3. **Given** the executor profiles are still loading while the agents list has already rendered, **When** resolution completes, **Then** the Executor cells fill in without the operator needing to reload.

---

### Edge Cases

- Agent with a role but an unresolvable executor (or vice versa): each column degrades independently — one shows its value, the other its empty/em-dash fallback.
- A long role string (up to 100 characters is accepted at creation): the Role cell must not break the table layout; the tag may truncate or wrap within its column.
- Workspace-setup runs (ticketless, orchestrator-driven): their agent carries role "teamlead" — the Runs Role column shows it like any other role.
- Executor profile list is empty (fresh platform, no profiles yet — normally impossible since agents require an executor, but defensive): all Executor cells render empty, no errors.
- Filtering, sorting, pagination, and row-click behavior of both lists must be unaffected by the added columns.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The workspace Runs list MUST display a "Role" column showing the functional role of the agent that owns each run.
- **FR-002**: A run whose agent has no role MUST show an em dash ("—") in the Role cell.
- **FR-003**: The Runs list Role column MUST be populated exclusively from data already present in the existing runs list response — no new or modified backend behavior.
- **FR-004**: On the workspace Agents list, the Name column MUST show only the agent's persona name; the inline "(role)" suffix MUST be removed.
- **FR-005**: The Agents list MUST display a "Role" column rendering the agent's role as a visually distinct tag; agents without a role MUST show an empty cell (no tag, no placeholder).
- **FR-006**: The Agents list Key column MUST remain unchanged.
- **FR-007**: The Agents list MUST display an "Executor" column showing the human-readable name of the executor profile the agent is bound to, resolved by cross-referencing the platform executor profiles; the raw internal executor id MUST never be shown.
- **FR-008**: When an agent's executor profile cannot be resolved, the Executor cell MUST render empty.
- **FR-009**: Both lists MUST retain all existing behavior (columns, filters, empty states, row navigation, pagination) unchanged.
- **FR-010**: New UI MUST follow the established dashboard conventions: brand colors only via the theme's state-color variables, the shared list pagination component (no bespoke pagination), and static icons outside the sidebar (no hover animation).
- **FR-011**: Frontend tests covering the new columns — role shown / em-dash fallback on Runs, name/role split and empty-role cell on Agents, executor name resolution and unresolvable fallback — MUST ship in the same iteration.

### Key Entities

- **Run (list item)**: A single pipeline execution shown on the Runs tab; references its agent (persona name, key, and nullable role) and a ticket, status, attempt, duration, and cost.
- **Agent**: A workspace team member with a persona name, derived key, nullable functional role (e.g. "Developer", "QA", "teamlead" for the orchestrator), and a reference to exactly one executor profile by id.
- **Executor profile**: A platform-scoped (not per-workspace) named configuration describing how agent processes run; the population is small and already listed by the dashboard's settings area.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can determine the functional role of the agent behind any run directly from the Runs list, without opening the run detail or knowing the team roster — 0 extra clicks (today: at least 1 navigation per run).
- **SC-002**: An operator can determine every agent's executor profile name directly from the Agents list — 0 extra clicks (today: 1 edit-form open per agent).
- **SC-003**: 100% of rows render a defined value in the new columns: a role or its documented fallback (em dash on Runs, empty on Agents), an executor profile name or an empty cell — a raw internal identifier is never visible.
- **SC-004**: Both lists render with no perceivable slowdown after the change (list appears as fast as before; executor-name resolution adds no per-row requests).
- **SC-005**: All acceptance scenarios above are covered by automated frontend tests passing in the same change.

## Assumptions

- The runs list API response already includes the agent's role in its agent reference; item 1 is frontend-only (verified against the current API contract).
- The agents list API response carries only the executor id; the executor profile name is resolved client-side against the existing platform executors list (an endpoint and data-access composable already exist). Executors are platform-scoped and few, so fetching the list once per page view is acceptable and adds no per-row requests.
- "Empty cell" on the Agents page means truly empty — visually distinct from the Runs page's em-dash convention; this asymmetry is intentional per the request.
- The human queue (ordering or otherwise) is explicitly out of scope, per requester clarification on 2026-07-17.
- No backend, database, or API contract changes are needed for any of the three items.
- UI-only change: per the project constitution (Principle VI), this qualifies for lighter coverage than pipeline logic, but the requester explicitly mandates frontend tests for the new columns in the same iteration (FR-011).

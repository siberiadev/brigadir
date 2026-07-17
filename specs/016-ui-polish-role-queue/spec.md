# Feature Specification: UI polish — agent role & executor visibility, human queue ordering

**Feature Branch**: `016-ui-polish-role-queue`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "UI polish: agent role and executor visibility, human queue ordering. Four small improvements to existing dashboard pages: (1) Runs list — add a Role column from the agent reference already present in the runs list response, em dash when absent. (2) Human queue OPEN tab sorted newest-first (single server-side ordering change shared by the global page and the workspace tab); History tab unchanged. (3) Agents page — split 'Name (role)' into a Name column and a separate Role column rendered as a tag, empty when absent. (4) Agents page — add an Executor column showing the executor profile name resolved from the platform executors list, empty when unresolvable."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Newest open human tasks appear on top (Priority: P1)

An operator watches the needs-human queue while several pipelines are running. When a new run pauses for human input, its task must be immediately visible at the top of the OPEN tab — both on the global human-queue page and on any workspace's Human queue tab — instead of buried behind older waiting tasks.

**Why this priority**: This is a behavioral change to an operational workflow (it deliberately reverses the earlier "longest-waiting on top" decision). Wrong ordering costs operators real time every day; the other three items are read-only visibility additions.

**Independent Test**: Create several open human tasks at different times, open the OPEN tab in both locations, and verify the most recently created task is first. Resolve tasks and verify the History tab still shows most recently resolved first.

**Acceptance Scenarios**:

1. **Given** three open human tasks created at 10:00, 11:00, and 12:00, **When** the operator opens the OPEN tab on the global human-queue page, **Then** the 12:00 task is listed first and the 10:00 task last.
2. **Given** the same tasks, **When** the operator opens the workspace's Human queue tab, **Then** the ordering is identical to the global page (newest first).
3. **Given** a new task is created while the operator is on page 1 of the OPEN tab, **When** the list refreshes, **Then** the new task appears at the top of page 1.
4. **Given** resolved tasks in the History tab, **When** the operator opens History, **Then** they remain ordered by resolution time, most recent first (unchanged behavior).
5. **Given** more open tasks than one page holds, **When** the operator pages through the OPEN tab, **Then** every task appears exactly once and no task is skipped or duplicated across pages (ordering is deterministic, including among tasks created at the same instant).

---

### User Story 2 - See which role a run belongs to in the runs list (Priority: P2)

An operator scanning a workspace's runs list wants to see, per run, the role of the agent that executed it (e.g. "developer", "reviewer") without opening each run's detail.

**Why this priority**: Runs are the most-viewed list in the dashboard; role is the fastest way to understand what stage of the pipeline a run represents. All data is already delivered to the page.

**Independent Test**: Open the Runs tab of a workspace that has runs from agents with and without roles; verify the new column shows the role or an em dash.

**Acceptance Scenarios**:

1. **Given** a run executed by an agent that has a role, **When** the operator views the workspace Runs tab, **Then** a "Role" column shows that agent's role for the run.
2. **Given** a run whose agent has no role, **When** the operator views the Runs tab, **Then** the Role cell shows an em dash (—).
3. **Given** the Runs tab before and after this change, **When** compared, **Then** all previously existing columns and their behavior are unchanged.

---

### User Story 3 - Agent role shown as its own column on the Agents page (Priority: P3)

An operator viewing a workspace's Agents tab sees each agent's persona name and role as separate columns instead of the combined "Name (role)" text, making the roster scannable.

**Why this priority**: Pure readability improvement on an existing page; no behavior change.

**Independent Test**: Open the Agents tab of a workspace with agents that do and do not have roles; verify Name shows only the persona name and Role appears as a distinct tagged column.

**Acceptance Scenarios**:

1. **Given** an agent with persona name "Vera" and role "reviewer", **When** the operator views the Agents tab, **Then** the Name column shows exactly "Vera" (no parenthesized role) and a separate "Role" column shows "reviewer" rendered as a tag.
2. **Given** an agent without a role, **When** the operator views the Agents tab, **Then** its Role cell is empty (no tag, no placeholder).
3. **Given** the existing Key column, **When** the new columns are added, **Then** the Key column remains present and unchanged.

---

### User Story 4 - Executor profile visible per agent (Priority: P3)

An operator viewing the Agents tab sees which executor profile each agent runs on, by human-readable profile name — not an internal identifier.

**Why this priority**: Same page and same audience as Story 3; useful when a workspace mixes executor profiles, but purely additive.

**Independent Test**: Open the Agents tab where agents reference known executor profiles; verify each shows the profile's name, and an agent whose executor cannot be resolved shows an empty cell.

**Acceptance Scenarios**:

1. **Given** an agent assigned to an executor profile named "claude-default", **When** the operator views the Agents tab, **Then** the "Executor" column shows "claude-default" and never the raw identifier.
2. **Given** an agent whose executor identifier does not match any known executor profile (or the executor list is unavailable), **When** the operator views the Agents tab, **Then** the Executor cell is empty and the rest of the table renders normally.

---

### Edge Cases

- Two open human tasks created at the same instant: ordering must still be deterministic and stable across pages and refreshes (a secondary tie-breaker is required).
- The executors lookup has not loaded yet (or fails) when the Agents tab renders: Executor cells are empty; the table must not error or block on the lookup.
- A run whose agent reference is missing entirely (deleted agent): the Role cell in the runs list shows the same em-dash fallback as a role-less agent.
- An agent's role is an empty string rather than absent: treated the same as "no role" (em dash in runs list, empty cell on Agents page).
- OPEN tab pagination combined with newest-first ordering: a task created between page loads shifts subsequent items; totals and page clamping must behave per the existing pagination conventions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The workspace runs list MUST display a "Role" column showing, for each run, the role of the agent that executed it; when the agent has no role (or no agent reference is present), the cell MUST show an em dash (—). Existing columns MUST be unchanged.
- **FR-002**: The needs-human queue's OPEN tab MUST list open tasks newest-first (most recently created on top) in both the global human-queue page and every workspace's Human queue tab, and the ordering MUST be identical in both places (it is one shared ordering, changed once at the source of the data).
- **FR-003**: The OPEN-tab ordering MUST be deterministic under pagination: tasks with identical creation times MUST have a stable, unique secondary ordering so no task is duplicated or skipped across pages.
- **FR-004**: The closed/History tab of the needs-human queue MUST retain its existing ordering (most recently resolved first) unchanged.
- **FR-005**: The workspace Agents page MUST show the agent's persona name alone in the Name column (no appended role) and MUST show the agent's role in a separate "Role" column rendered as a tag; agents without a role MUST show an empty Role cell. The existing Key column MUST remain unchanged.
- **FR-006**: The workspace Agents page MUST show an "Executor" column containing the human-readable name of the agent's executor profile, resolved from the platform's executor profiles; the raw executor identifier MUST never be displayed.
- **FR-007**: When an agent's executor profile cannot be resolved (unknown identifier, or the profile lookup is unavailable/not yet loaded), the Executor cell MUST be empty and the page MUST continue to render normally.
- **FR-008**: All four changes MUST follow the established dashboard conventions: brand colors only via the shared theme variables, the shared pagination component/behavior, and static icons outside the sidebar.
- **FR-009**: Automated frontend tests covering the new Role and Executor columns (including fallback cells) and the OPEN-tab newest-first ordering MUST ship in the same change.

### Key Entities

- **Run**: A single pipeline execution; carries a reference to the agent that executed it, which includes the agent's role. Displayed in the workspace runs list.
- **Human task**: A request for human input created by a run; has a creation time (orders the OPEN tab) and a resolution time (orders the History tab).
- **Agent**: A workspace-scoped worker with a persona name, an optional role, a routing key, and a reference to an executor profile.
- **Executor profile**: A platform-scoped execution configuration with a human-readable name; referenced by agents via an identifier. Few exist per installation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can identify the newest open human task in at most one glance at the OPEN tab (it is always the first row on page 1) — in both the global queue and any workspace's queue, with zero discrepancy between the two.
- **SC-002**: An operator can determine the role behind any run and the role/executor of any agent directly from the respective list, without opening a detail view or cross-referencing identifiers — for 100% of rows, including those where the value is absent (a consistent placeholder is shown instead of missing or broken cells).
- **SC-003**: Paging through the OPEN tab in any state (including simultaneous task creation times) shows every open task exactly once.
- **SC-004**: No previously existing list behavior regresses: History-tab ordering, existing columns, filters, and pagination behave exactly as before the change.

## Assumptions

- "Newest-first" for the OPEN tab is defined by task creation time; ties are broken by a stable unique attribute of the task so the ordering is deterministic (per the project-wide deterministic-ordering rule for paginated lists).
- The runs list already delivers the agent's role with each run (per the feature description), so item 1 requires no server-side change; item 2 is a single server-side ordering change; items 3–4 are display-only changes on the Agents page.
- Executor profiles are platform-scoped and few, so resolving names from the full executors list (an existing endpoint and composable) is acceptable without a dedicated lookup endpoint.
- An empty-string role is treated identically to an absent role.
- Column labels are "Role" and "Executor" in the dashboard's existing language/casing conventions; no localization work is in scope.
- No changes to run/agent/human-task data models, endpoints' response shapes, or Jira behavior are in scope; the only server-side behavior change is the OPEN-tab sort order.

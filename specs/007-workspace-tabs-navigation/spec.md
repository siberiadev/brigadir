# Feature Specification: Workspace Tabs Navigation

**Feature Branch**: `main` (spec merged via PR #1; branch squashed and deleted)

**Created**: 2026-07-13

**Status**: Draft

**Input**: User description: "Feature 007: workspace tabs navigation — rework the workspace-level navigation per docs/plan-internal.md iteration 7 (decision 2026-07-13). Remove the Agents and Runs action buttons from the workspace list (WorkspaceList.vue keeps Settings and Start/Pause); clicking a workspace ROW navigates to the workspace page. The workspace page gets a shared, reusable tabs component with two tabs — Agents | Runs — switching tabs swaps the list below without a full page reload and reflects the active tab in the URL. Existing deep-link routes /workspaces/:id/agents and /workspaces/:id/runs MUST keep working (they resolve to the workspace page with the corresponding tab active) — the run card, human queue, and navbar link into them. Frontend-only: no backend/API/contract changes, no schema changes. Follow the existing FormDialog/el-dialog component conventions and the current SCSS structure. Tests: msw component tests for tab switching, row-click navigation, and deep-link tab resolution, extending apps/web/test/{mount,handlers}.ts. Out of scope: the icon sidebar (iteration 8), any new data on the tabs."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open a workspace and switch between its Agents and Runs (Priority: P1)

An operator viewing the workspace list clicks a workspace row and lands on that
workspace's page. The page shows two tabs — **Agents** and **Runs** — with the
Agents list visible by default. Clicking the **Runs** tab swaps the content
below the tabs to the runs list without reloading the whole page; clicking
**Agents** swaps it back. The browser address reflects which tab is active, so
the current view can be bookmarked, shared, or reached with the browser back/
forward buttons.

**Why this priority**: This is the core of the feature — it replaces the two
separate per-workspace action buttons with a single, coherent workspace page
and is the reason the iteration exists. Without it there is no feature.

**Independent Test**: Open the workspace list, click a workspace row, confirm
the Agents list renders under an Agents/Runs tab strip, click Runs and confirm
the runs list replaces it (and the address updates), click Agents and confirm
the agents list returns.

**Acceptance Scenarios**:

1. **Given** the workspace list is displayed, **When** the operator clicks a
   workspace row, **Then** the workspace page opens with the Agents tab active
   and the agents list for that workspace shown below the tabs.
2. **Given** the workspace page is open on the Agents tab, **When** the operator
   selects the Runs tab, **Then** the runs list for the same workspace replaces
   the agents list without a full page reload and the active tab is Runs.
3. **Given** the workspace page is open on the Runs tab, **When** the operator
   selects the Agents tab, **Then** the agents list returns without a full page
   reload and the active tab is Agents.
4. **Given** the workspace page is open on any tab, **When** the operator reads
   the browser address, **Then** it identifies both the workspace and the
   active tab.

---

### User Story 2 - Deep-links to a workspace's agents or runs keep working (Priority: P1)

Anyone following an existing link, bookmark, or shared address that points at a
workspace's agents view or runs view arrives at the workspace page with the
matching tab already active. The address forms that other parts of the product
already use to point into a workspace (from the run card, the human queue, and
the top navigation) continue to resolve to the correct workspace and tab.

**Why this priority**: Existing links are relied upon by operators and by other
parts of the product; silently breaking them would strand people mid-task and
regress shipped behavior. Backward compatibility is a hard requirement of the
iteration decision.

**Independent Test**: Navigate directly to a workspace's runs address and
confirm the workspace page opens with the Runs tab active and the runs list
shown; navigate directly to a workspace's agents address and confirm the Agents
tab is active.

**Acceptance Scenarios**:

1. **Given** a direct navigation to a workspace's runs address, **When** the
   page loads, **Then** the workspace page opens with the Runs tab active and
   the runs list for that workspace shown.
2. **Given** a direct navigation to a workspace's agents address, **When** the
   page loads, **Then** the workspace page opens with the Agents tab active and
   the agents list for that workspace shown.
3. **Given** the operator switches tabs on the workspace page, **When** they use
   the browser back button, **Then** they return to the previously active tab
   rather than leaving the workspace page entirely.

---

### User Story 3 - Workspace list stays focused on lifecycle actions (Priority: P2)

On the workspace list, each row no longer carries **Agents** and **Runs**
buttons. The remaining per-row actions are **Settings** and **Start/Pause**,
which keep working exactly as before. The whole row is the way into the
workspace, so the row communicates that it is clickable.

**Why this priority**: Removing the redundant buttons is what makes room for the
row-click navigation and reduces clutter, but the workspace page (US1/US2) is
what delivers the value; this story is the cleanup that accompanies it.

**Independent Test**: Open the workspace list and confirm no Agents or Runs
buttons appear on any row, while Settings and Start/Pause remain and still open
the settings view and toggle the pause state respectively.

**Acceptance Scenarios**:

1. **Given** the workspace list is displayed, **When** the operator inspects a
   row, **Then** no Agents button and no Runs button are present, and Settings
   and Start/Pause are present.
2. **Given** the workspace list is displayed, **When** the operator clicks
   Settings on a row, **Then** the workspace settings view opens as it did
   before this change.
3. **Given** the workspace list is displayed, **When** the operator clicks
   Start/Pause on a row, **Then** the workspace pause state toggles as it did
   before this change, and the row does not also navigate into the workspace.

---

### Edge Cases

- **Unknown or invalid tab in the address**: if the address names a tab that is
  not Agents or Runs, the workspace page falls back to the default (Agents) tab
  rather than showing an empty view.
- **Row action vs. row navigation**: clicking a per-row control (Settings,
  Start/Pause) must perform only that action and must NOT also trigger
  navigation into the workspace.
- **Switching tabs does not lose scroll/reload cost**: switching tabs swaps only
  the list region; it must not re-mount the entire application shell or force a
  network re-fetch of unrelated data.
- **Direct link to a nonexistent workspace**: the workspace page behaves the
  same as the current per-view behavior for an unknown workspace id (it does not
  crash; it shows whatever the underlying list would show for that id).
- **Back/forward across tab switches**: browser history reflects tab changes so
  back/forward move between tabs of the same workspace.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The workspace list MUST NOT display per-row Agents or Runs action
  buttons.
- **FR-002**: The workspace list MUST retain the per-row Settings action and the
  per-row Start/Pause action with their existing behavior unchanged.
- **FR-003**: Clicking a workspace row (outside of the row's action controls)
  MUST navigate to that workspace's page.
- **FR-004**: Activating a per-row action control (Settings, Start/Pause) MUST
  NOT also trigger row navigation.
- **FR-005**: The workspace page MUST present exactly two tabs, labelled
  **Agents** and **Runs**, in that order.
- **FR-006**: The workspace page MUST default to the Agents tab when no specific
  tab is requested.
- **FR-007**: Selecting a tab MUST replace the content region below the tab
  strip with the corresponding list (agents list or runs list) for the current
  workspace without performing a full page reload.
- **FR-008**: The currently active tab MUST be reflected in the browser address
  so the view can be bookmarked, shared, and restored.
- **FR-009**: The address that identifies a workspace's agents view MUST resolve
  to the workspace page with the Agents tab active, and the address that
  identifies a workspace's runs view MUST resolve to the workspace page with the
  Runs tab active — both of the currently shipped address forms MUST continue to
  work.
- **FR-010**: Tab changes MUST participate in browser history so back/forward
  navigation moves between the previously viewed tabs of the same workspace.
- **FR-011**: The Agents tab MUST show the same agents list, with the same
  actions, that the existing agents view shows today; the Runs tab MUST show the
  same runs list, filters, cost header, and row-to-run navigation that the
  existing runs view shows today. No data or capability is added or removed on
  either tab.
- **FR-012**: An address that requests an unrecognized tab MUST fall back to the
  default (Agents) tab rather than rendering an empty or broken view.
- **FR-013**: The tab strip MUST be implemented as a single shared, reusable
  component so that the same tab affordance can be reused as the workspace-level
  navigation grows.
- **FR-014**: The change MUST be frontend-only: no backend endpoint, API
  contract, or database schema is altered.
- **FR-015**: New and revised components MUST follow the existing dialog
  component conventions and the current styling structure used elsewhere in the
  dashboard.

### Key Entities

- **Workspace page**: the per-workspace destination reached by clicking a
  workspace row; hosts the tab strip and the active tab's list. Identified by a
  workspace.
- **Workspace tab**: one of two selectable views (Agents, Runs) on the workspace
  page; has a label, a stable identifier used in the address, and an associated
  list. Exactly one tab is active at a time.
- **Tabs component**: the shared, reusable affordance that renders the tab
  labels, indicates the active tab, and emits/*reflects* tab selection; reused
  as workspace-level navigation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From the workspace list, an operator can reach a workspace's runs
  view in one row click plus at most one tab click (down from locating and
  clicking a per-row Runs button).
- **SC-002**: 100% of the previously working links to a workspace's agents view
  and runs view still open the correct workspace with the correct tab active
  after the change.
- **SC-003**: Switching between the Agents and Runs tabs updates the visible
  list without a full page reload, verifiable in an automated component test.
- **SC-004**: The workspace list shows zero per-row Agents or Runs buttons while
  Settings and Start/Pause remain fully functional, verifiable in an automated
  component test.
- **SC-005**: Automated component tests cover tab switching, row-click
  navigation, and deep-link tab resolution, and all pass.
- **SC-006**: No backend, API contract, or schema files are changed by the
  feature (the diff is confined to the frontend).

## Assumptions

- The existing per-workspace agents list and runs list views are reused as the
  content of the two tabs; their internal behavior (agent CRUD, run filters,
  cost header, run-card navigation) is unchanged.
- The two currently shipped address forms for a workspace's agents view and runs
  view remain the canonical deep-link targets; the workspace page resolves both
  (and its own default) to the correct active tab.
- "Reflects the active tab in the URL" is satisfied by the address unambiguously
  identifying both workspace and active tab; the exact address shape is an
  implementation detail left to planning, provided the two existing deep-link
  forms keep resolving.
- The top navigation's Workspaces and Human queue links and the run card's
  existing links are unaffected except that any link pointing at a workspace's
  agents or runs view continues to resolve (via FR-009).
- The icon sidebar (iteration 8) and any new data surfaced on the tabs are out
  of scope for this feature.
- Component tests use the project's existing msw-based frontend test harness and
  extend the shared mount/handlers helpers rather than introducing a new testing
  approach.

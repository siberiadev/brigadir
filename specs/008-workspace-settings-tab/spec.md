# Feature Specification: Workspace Settings Tab

**Feature Branch**: `main` (small UI iteration; spec merged via PR per iteration cadence)

**Created**: 2026-07-13

**Status**: Draft

**Input**: User description: "Feature 008: workspace Settings tab — per docs/plan-internal.md iteration 8 (decision 2026-07-13). Add a third tab Settings to the workspace page (after Agents | Runs, reusing the shared WorkspaceTabs component from feature 007). The tab shows the workspace configuration as READ-ONLY STRUCTURED DATA — el-descriptions blocks, explicitly NOT forms with disabled fields — organized as: (1) a Jira connection block (site URL, project, board + type, bot email, token expiry + credential status) with an Edit button opening a MODAL with the reconnect/re-verify form; (2) a workspace configuration block (default branch prefix, advanced settings, repositories list with default marked) with an Edit button opening a MODAL with the config/repositories form; (3) the executors admin section stays as it is today (table + create/edit modals) inside the tab. Current state after 007: the standalone settings page at /workspaces/:id/settings exists and the workspace list's Settings action navigates to it. This feature RETIRES the standalone page: the /workspaces/:id/settings route must resolve to the workspace page with the Settings tab active (deep-links keep working), and the list's Settings action leads to that tab. Also fix the known shared-dialog race in this iteration since all Edit modals ride on it: reopening a FormDialog while the previous instance's close animation is still running renders an empty dialog (title + footer only) — components/FormDialog.vue, reproduced 2026-07-13 during live QA. Frontend-only: no backend/API/contract/schema changes (the read-only blocks render data already returned by GET /api/workspaces/:id). Tests: msw component tests for the readonly blocks rendering workspace data, Edit-modal open/submit round-trips, the settings deep-link resolving to the tab, and a regression test for the FormDialog reopen race. Out of scope: icon sidebar (iteration 9), any new backend data, per-field inline editing."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Review workspace settings as read-only data under a Settings tab (Priority: P1)

An operator opens a workspace and selects a third tab, **Settings**, sitting
after **Agents** and **Runs**. Instead of a page full of editable form fields,
the operator sees the workspace's current configuration laid out as clearly
labelled read-only value blocks: a **Jira connection** block (site, project,
board and its type, bot email, token expiry and credential status), a
**workspace configuration** block (default branch prefix, advanced settings,
and the repositories list with the default repository marked), and the existing
**executors** administration section. The operator can read the whole
configuration at a glance without any risk of accidentally editing it.

**Why this priority**: This is the core of the iteration — turning the settings
surface from an always-editable form into a legible, read-first view is the
reason the feature exists. Without it there is no feature.

**Independent Test**: Open a workspace, select the Settings tab, and confirm the
Jira connection, configuration, and executors sections render the workspace's
actual values as read-only blocks (not editable inputs), with the default
repository visibly marked.

**Acceptance Scenarios**:

1. **Given** a workspace page is open, **When** the operator looks at the tab
   strip, **Then** a third tab **Settings** appears after **Agents** and
   **Runs**.
2. **Given** the Settings tab is selected, **When** the tab content renders,
   **Then** the Jira connection values (site, project, board + type, bot email,
   token expiry, credential status) are shown as read-only labelled data, not as
   editable form fields.
3. **Given** the Settings tab is selected, **When** the tab content renders,
   **Then** the workspace configuration (default branch prefix, advanced
   settings, repositories with the default repository marked) is shown as
   read-only labelled data.
4. **Given** the Settings tab is selected, **When** the tab content renders,
   **Then** the executors administration section is present with the same table
   and create/edit/delete controls it has today.

---

### User Story 2 - Edit Jira connection and workspace configuration via modals (Priority: P1)

From the read-only Settings view, each editable block carries an **Edit**
button. Pressing **Edit** on the Jira connection block opens a modal containing
the reconnect / re-verify form; pressing **Edit** on the configuration block
opens a modal containing the branch-prefix / advanced-settings / repositories
form. The operator changes values, submits, and the modal closes; the read-only
blocks then reflect the saved values. Cancelling or closing a modal leaves the
configuration untouched.

**Why this priority**: Read-only data is only useful if the operator can still
change the configuration; the edit path preserves every capability the old
standalone page had, just relocated into modals. Ships alongside US1.

**Independent Test**: On the Settings tab, click Edit on the Jira connection
block, confirm the reconnect form appears in a modal, submit a change and
confirm the modal closes and the connection block reflects the update; repeat
for the configuration block's Edit → repositories/branch form.

**Acceptance Scenarios**:

1. **Given** the Settings tab is showing the read-only Jira connection block,
   **When** the operator clicks its Edit button, **Then** a modal opens
   containing the reconnect / re-verify form pre-populated for editing.
2. **Given** the Jira connection edit modal is open, **When** the operator
   submits a valid change, **Then** the modal closes and the read-only Jira
   connection block reflects the saved values.
3. **Given** the Settings tab is showing the read-only configuration block,
   **When** the operator clicks its Edit button, **Then** a modal opens
   containing the branch-prefix / advanced-settings / repositories form.
4. **Given** the configuration edit modal is open, **When** the operator submits
   a valid change, **Then** the modal closes and the read-only configuration
   block (including the repositories list and default marker) reflects the saved
   values.
5. **Given** an edit modal is open, **When** the operator cancels or closes it
   without submitting, **Then** the configuration is unchanged.

---

### User Story 3 - The settings deep-link resolves to the Settings tab (Priority: P1)

Anyone following the existing address `/workspaces/:id/settings` — from the
workspace list's **Settings** action, a bookmark, or a shared link — arrives at
the workspace page with the **Settings** tab already active, rather than a
separate standalone settings page. The standalone page is retired; its address
is preserved as a deep-link into the tab.

**Why this priority**: The list's Settings action and existing links point at
this address; retiring the standalone page without preserving the address would
strand operators and regress shipped navigation. Backward compatibility is a
hard requirement of the iteration decision.

**Independent Test**: Navigate directly to `/workspaces/:id/settings` (and via
the list's Settings action) and confirm the workspace page opens with the
Settings tab active and its content shown — with no separate standalone settings
page rendered.

**Acceptance Scenarios**:

1. **Given** the workspace list is displayed, **When** the operator triggers the
   Settings action on a workspace, **Then** the workspace page opens with the
   Settings tab active.
2. **Given** a direct visit to `/workspaces/:id/settings`, **When** the page
   loads, **Then** the workspace page renders with the Settings tab active and
   the read-only settings content shown.
3. **Given** the operator is on the Settings tab, **When** they read the browser
   address, **Then** it identifies both the workspace and that Settings is the
   active tab.

---

### User Story 4 - Reopening an edit modal always shows its content (Priority: P2)

An operator opens an Edit modal, closes it, and immediately opens another (or
the same) Edit modal. The newly opened modal always shows its full content —
title, body form, and footer — never an empty shell with only a title and
footer. This holds even when the second open happens before the first modal's
close animation has finished.

**Why this priority**: Every Edit button on the Settings tab rides on the shared
modal wrapper, so a reopen glitch is now reachable from multiple buttons in
quick succession. It is a known defect reproduced during live QA on 2026-07-13;
fixing it here keeps the new edit flows trustworthy. It is a robustness fix
rather than the core capability, hence P2.

**Independent Test**: Open an Edit modal, close it, and open an Edit modal again
immediately (within the close-animation window); confirm the second modal
renders its form body, not an empty title+footer shell.

**Acceptance Scenarios**:

1. **Given** an Edit modal was just closed and its close transition is still in
   progress, **When** the operator opens an Edit modal again, **Then** the modal
   renders with its full body content, not an empty shell.
2. **Given** any Edit modal on the Settings tab, **When** it is opened after a
   prior modal was dismissed, **Then** its form fields are present and
   interactive.

---

### Edge Cases

- **Missing / null Jira fields**: When board id, board type, or token expiry are
  absent for a workspace, the connection block shows a clear empty/placeholder
  state rather than a broken or blank row.
- **No repositories configured**: The configuration block shows an explicit
  "no repositories" state rather than an empty list with a phantom default
  marker.
- **Data not present in the workspace response**: Fields that the workspace
  detail response does not carry (see Assumptions) must not render as blank
  read-only rows implying missing data; they are surfaced only inside the
  relevant Edit modal where the operator provides them.
- **Unknown tab segment**: A workspace sub-path that is neither agents, runs, nor
  settings continues to resolve to the default tab (unchanged from feature 007).
- **Reconnect re-verify failure**: A failed re-verify inside the Jira edit modal
  surfaces the error and retains the previously working connection (unchanged
  behavior, now inside the modal).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The workspace page MUST present a third tab, **Settings**, after
  the **Agents** and **Runs** tabs, using the same shared tabs component
  introduced in feature 007.
- **FR-002**: Selecting the Settings tab MUST swap the content below the tab
  strip to the settings view without a full page reload, consistent with the
  other tabs.
- **FR-003**: The Settings tab MUST display the Jira connection details (site
  URL, project, board and board type, bot email, token expiry, and credential
  status) as read-only structured data blocks, NOT as forms with disabled
  fields.
- **FR-004**: The Settings tab MUST display the workspace configuration (default
  branch prefix, advanced settings, and the repositories list with the default
  repository clearly marked) as read-only structured data blocks, NOT as forms
  with disabled fields.
- **FR-005**: The read-only Jira connection block MUST carry an **Edit** control
  that opens a modal containing the reconnect / re-verify form.
- **FR-006**: The read-only configuration block MUST carry an **Edit** control
  that opens a modal containing the branch-prefix / advanced-settings /
  repositories form.
- **FR-007**: Submitting a valid change in either edit modal MUST persist it via
  the existing endpoints, close the modal, and cause the corresponding read-only
  block to reflect the saved values.
- **FR-008**: Cancelling or closing an edit modal without submitting MUST leave
  the workspace configuration unchanged.
- **FR-009**: The executors administration section (table plus create / edit /
  delete controls in their modals) MUST remain available within the Settings
  tab with its current behavior.
- **FR-010**: The address `/workspaces/:id/settings` MUST resolve to the
  workspace page with the Settings tab active (deep-link preserved), and the
  standalone settings page MUST be retired.
- **FR-011**: The workspace list's **Settings** action MUST lead to the
  workspace page with the Settings tab active.
- **FR-012**: The active tab (including Settings) MUST be reflected in the
  browser address so the view can be bookmarked, shared, and reached via
  browser back/forward — consistent with feature 007.
- **FR-013**: The shared modal wrapper MUST reliably render full content (title,
  body, footer) when a modal is opened immediately after a prior modal was
  closed, including while the prior close transition is still running — it MUST
  NOT render an empty title+footer shell.
- **FR-014**: The feature MUST NOT change the database schema or the run/
  callback pipeline. ONE additive, non-breaking API extension is in scope
  (checkpoint amendment 2026-07-13): the workspace detail response gains the
  bot email, the default branch prefix, and the advanced scope filter — the
  fields the read-only blocks are required to display (FR-003/FR-004) — and the
  edit modals MUST seed their inputs from these persisted values. Credentials
  (API token) remain never serialized. No other endpoint or contract changes.
- **FR-015**: All read-only blocks MUST degrade gracefully for absent/nullable
  values (e.g., missing board, token expiry, or empty repositories) without
  broken or misleading rows.

### Key Entities *(include if data involved)*

- **Workspace settings view**: The read-first presentation of an existing
  workspace's configuration, grouped into a Jira connection block, a
  configuration block, and an executors section — all derived from the current
  workspace detail response; no new persisted data.
- **Jira connection block**: Site URL, project key, board id + board type, bot
  email, token expiry, and credential status — read-only, with an Edit action to
  the reconnect form.
- **Workspace configuration block**: Default branch prefix, advanced settings
  (e.g., scope filter), and the repositories list with the default repository
  marked — read-only, with an Edit action to the configuration form.
- **Edit modal**: A dialog hosting one of the existing forms (reconnect or
  configuration or executor), dismissed only via its explicit controls, that
  must render its full content reliably across rapid close/reopen cycles.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can read the complete Jira connection, configuration,
  and executors state of a workspace from a single Settings tab without
  encountering any editable field in the read-only blocks.
- **SC-002**: Every editable capability the retired standalone page offered
  (reconnect/re-verify, branch prefix, advanced settings, repositories, executor
  CRUD) remains reachable from the Settings tab via its Edit modals, with 100%
  of those capabilities preserved.
- **SC-003**: 100% of visits to `/workspaces/:id/settings` (direct link and via
  the list's Settings action) land on the workspace page with the Settings tab
  active; no standalone settings page is rendered.
- **SC-004**: Opening an Edit modal immediately after closing one shows its full
  content in 100% of attempts, including within the close-animation window (zero
  empty-shell occurrences in the regression test).
- **SC-005**: The diff is confined to the frontend plus the single additive
  workspace-response extension (contract + response mapping + its tests); no
  database schema change, no pipeline change, no other endpoint touched.
- **SC-006**: Automated component tests cover the read-only blocks rendering
  workspace data, both Edit-modal open/submit round-trips, the settings
  deep-link resolving to the tab, and the modal reopen-race regression.

## Assumptions

- The shared tabs component and the workspace-page shell from feature 007 are
  reused as-is; this feature adds a Settings tab to them rather than introducing
  a new navigation pattern.
- The existing forms retire from the standalone page and are reused inside
  modals: the reconnect/re-verify form, the configuration/repositories form, and
  the executor form — no form logic is rewritten, only relocated.
- The workspace detail response does NOT currently serialize the bot email,
  default branch prefix, or advanced scope filter. **Checkpoint amendment
  (2026-07-13)**: rather than hiding these fields from the read-only blocks,
  the response is extended additively to include them (FR-014). This also
  fixes a pre-existing footgun confirmed during the checkpoint: the standalone
  settings form seeded prefix/scope from hard-coded defaults (`feat` / empty)
  instead of persisted values — see the code comment in the current settings
  view ("The workspace response exposes repositories but not
  scope_jql/branch_prefix") — so re-saving could silently overwrite a
  customized prefix with `feat`. With the extension, the edit modals seed from
  what is actually stored. The exact final composition of the read-only blocks
  remains a user-participation checkpoint for this iteration.
- The modal reopen-race fix is a change to the shared modal wrapper's rendering
  lifecycle only; it does not alter dialog dismissal rules (close only via the
  X, ESC, or explicit footer buttons — no close on outside click).
- "Retiring" the standalone page means the address stays valid as a deep-link
  into the tab; it does not mean removing the address.
- The icon sidebar (iteration 9), any new backend data, and per-field inline
  editing are out of scope.

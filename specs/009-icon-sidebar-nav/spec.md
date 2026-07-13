# Feature Specification: Icon Sidebar Navigation

**Feature Branch**: `009-icon-sidebar-nav`

**Created**: 2026-07-13

**Status**: Draft

**Input**: User description: "Feature 009: icon sidebar navigation — per docs/plan-internal.md iteration 9 (decision 2026-07-13). Replace the current top header menu with a narrow fixed LEFT sidebar (~70px wide, full viewport height); the top header disappears entirely as a navigation surface. Sidebar contents, top to bottom: (1) a compact brand mark at the top; (2) navigation items as ICONS ONLY, no labels: Workspaces and Human queue, using the lucide icon library via lucide-vue-next; (3) pinned to the bottom: the Sign out action as an icon. Behavior: tooltip on hover (Element Plus, placed right); active route section highlighted; the open-human-tasks count badge moves from the header text link onto the Human queue ICON; the open>0 landing rule from 006 is unchanged. Main content shifts right by the sidebar width. Frontend-only; the token gate stays full-screen WITHOUT the sidebar. Tests via msw component tests. Out of scope: collapsible sidebar, mobile/responsive, new nav destinations, theming beyond the sidebar."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate the app from an icon sidebar (Priority: P1)

An authenticated operator sees a narrow vertical sidebar fixed to the left edge of the app. It holds a compact brand mark at the top and two icon-only navigation items — Workspaces and Human queue. Clicking an icon navigates to that section. Hovering an icon reveals a tooltip naming the destination, so the operator can learn the icons without labels taking up space. The main content area sits to the right of the sidebar and is never covered by it.

**Why this priority**: This is the core of the feature — the navigation surface itself. Without it there is no sidebar. It replaces the existing top-header menu and delivers the primary value: a compact, always-visible navigation rail.

**Independent Test**: Mount the authenticated app shell, confirm the sidebar renders with a brand mark plus the two navigation icons, confirm each icon carries a hover tooltip with the correct name, confirm clicking each icon routes to the matching section, and confirm the content region is offset to the right of the sidebar (no overlap).

**Acceptance Scenarios**:

1. **Given** an authenticated operator on any app route, **When** the app shell renders, **Then** a fixed left sidebar is shown containing a brand mark, a Workspaces icon, and a Human queue icon, and no top navigation header is present.
2. **Given** the sidebar is visible, **When** the operator hovers the Workspaces icon, **Then** a tooltip reading "Workspaces" appears to the right of the icon; hovering the Human queue icon shows a tooltip reading "Human queue".
3. **Given** the sidebar is visible, **When** the operator clicks the Workspaces icon, **Then** the app navigates to the workspaces list; **When** the operator clicks the Human queue icon, **Then** the app navigates to the human queue.
4. **Given** the sidebar and main content are rendered, **When** the layout is measured, **Then** the main content begins to the right of the sidebar's width and no content renders underneath the sidebar.

---

### User Story 2 - See which section I'm in and how many tasks await (Priority: P1)

The sidebar visually highlights the navigation item for the section the operator is currently in, so at a glance they know where they are. The live count of open human tasks — previously shown as a badge on the header text link — now appears as a small corner badge on the Human queue icon, and keeps updating via the existing polling. When the open count is zero, no badge is shown.

**Why this priority**: Orientation (active highlight) and the live open-task signal are the two pieces of state the operator relies on most; they moved off the header and must survive the migration intact. Same priority as US1 because the sidebar is not a faithful replacement without them.

**Independent Test**: Mount the shell on each route and assert the correct item is highlighted; drive the mocked open-count to a positive number and assert a badge with that value appears on the Human queue icon; drive it to zero and assert no badge is shown.

**Acceptance Scenarios**:

1. **Given** the operator is on the workspaces list (`/`) or any workspace sub-route (`/workspaces/*`), **When** the sidebar renders, **Then** the Workspaces item is highlighted as active and the Human queue item is not.
2. **Given** the operator is on the human queue (`/human-queue`), **When** the sidebar renders, **Then** the Human queue item is highlighted as active and the Workspaces item is not.
3. **Given** the open human-task count resolves to a positive number N, **When** the sidebar renders, **Then** a corner badge showing N (capped at a max display value) appears on the Human queue icon.
4. **Given** the open human-task count is zero, **When** the sidebar renders, **Then** no badge is shown on the Human queue icon.
5. **Given** the polled open count changes while the operator is in the app, **When** the new value arrives, **Then** the badge on the Human queue icon updates to reflect it.

---

### User Story 3 - Sign out from the sidebar (Priority: P2)

The Sign out action is an icon pinned to the bottom of the sidebar, separated from the navigation items. Activating it clears the session token, returns the operator to the full-screen token gate, and removes the sidebar (the gate has no sidebar).

**Why this priority**: Sign out is essential but low-frequency and mechanically simple relative to navigation; it is the last piece to migrate off the header.

**Independent Test**: Mount the authenticated shell, activate the Sign out icon, and assert the token is cleared, the token gate is shown, and the sidebar is no longer rendered.

**Acceptance Scenarios**:

1. **Given** an authenticated operator, **When** they activate the Sign out icon at the bottom of the sidebar, **Then** the session token is cleared and the full-screen token gate is shown.
2. **Given** the operator has signed out, **When** the gate is shown, **Then** the sidebar is not rendered.
3. **Given** the sidebar is rendered, **When** the operator hovers the Sign out icon, **Then** a tooltip reading "Sign out" appears to the right of the icon.

---

### User Story 4 - Pre-auth gate has no sidebar (Priority: P2)

Before authenticating, the operator sees only the full-screen token gate — no sidebar. The sidebar belongs to the authenticated app shell and only appears once a valid token is entered.

**Why this priority**: Prevents the navigation rail from leaking into the unauthenticated screen; important for correctness but a narrow, single-condition guarantee.

**Independent Test**: Mount the app with no token present and assert the token gate renders full-screen with no sidebar; then set a token and assert the sidebar appears.

**Acceptance Scenarios**:

1. **Given** no session token is present, **When** the app renders, **Then** the full-screen token gate is shown and no sidebar is present.
2. **Given** the operator enters a valid token, **When** the app shell renders, **Then** the sidebar appears alongside the main content.

---

### Edge Cases

- **Open count > 99**: the badge shows a capped display (e.g. "99+") rather than an unbounded number; the existing badge cap behavior from the header is preserved.
- **Count not yet loaded**: before the first poll resolves, the Human queue icon shows no badge (treated as zero) rather than a spinner or placeholder number.
- **Deep sub-routes of a workspace** (e.g. `/workspaces/:id/settings`): the Workspaces item stays highlighted, since active state is determined by route section, not exact path.
- **Landing rule interaction**: the open>0 auto-landing behavior from feature 006 is unchanged — if the count first resolves with open>0 while sitting on the workspaces root, the operator is still redirected to the queue; the sidebar migration does not alter this.
- **Route with no matching nav section** (e.g. the standalone run card `/runs/:id`): no navigation item is highlighted; the sidebar still renders normally.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The authenticated app shell MUST present a fixed left sidebar spanning the full viewport height, approximately 70px wide, in place of the previous top navigation header.
- **FR-002**: The top header MUST be removed as a navigation surface; brand mark, navigation, and sign-out MUST live in the sidebar.
- **FR-003**: The sidebar MUST show, top to bottom: (1) a compact brand mark representing BRIGADIR in the reduced width, (2) icon-only navigation items for Workspaces and Human queue, and (3) a Sign out icon pinned to the bottom, visually separated from the navigation items.
- **FR-004**: Navigation items MUST be rendered as icons only, with no visible text labels, using semantically recognizable glyphs (a boards/boxes-style glyph for Workspaces, an inbox/queue-style glyph for Human queue; final glyph choice made during planning).
- **FR-005**: Each navigation item and the Sign out item MUST show a tooltip with its name ("Workspaces", "Human queue", "Sign out") on hover, positioned to the right of the icon.
- **FR-006**: The sidebar MUST highlight the navigation item corresponding to the active route section: Workspaces is active for `/` and any `/workspaces/*` route; Human queue is active for `/human-queue`.
- **FR-007**: When no route section matches (e.g. the standalone run card), no navigation item is highlighted and the sidebar still renders normally.
- **FR-008**: The live open-human-tasks count MUST be shown as a small corner badge on the Human queue icon, sourced from the existing open-count polling used previously by the header link.
- **FR-009**: When the open count is zero (or not yet loaded), the Human queue icon MUST show no badge.
- **FR-010**: The badge value MUST update as the polled open count changes and MUST display a capped value for large counts, preserving the prior header badge's cap behavior.
- **FR-011**: The main content area MUST be offset to the right by the sidebar width so that no content renders underneath the sidebar.
- **FR-012**: Activating the Sign out icon MUST clear the session token, return to the full-screen token gate, and remove the sidebar.
- **FR-013**: The pre-auth token gate MUST render full-screen without a sidebar; the sidebar MUST render only for the authenticated app shell.
- **FR-014**: The open>0 landing rule from feature 006 MUST remain unchanged in behavior.
- **FR-015**: The change MUST be frontend-only — no backend, API, contract, or schema changes; the open-count data continues to come from the existing count hook.
- **FR-016**: Automated component tests (with request mocking) MUST cover: sidebar rendering (icons + tooltips), active-item highlighting per route, the badge on the Human queue icon including the zero → no-badge case, sign-out behavior (token cleared, gate shown, sidebar gone), and the pre-auth gate rendering without a sidebar.

### Key Entities

- **Navigation item**: a sidebar entry with an icon, a hover tooltip name, a destination route, and an active-when route-matching rule. Two exist: Workspaces and Human queue.
- **Open-task badge**: a live numeric indicator attached to the Human queue navigation item, driven by the existing open-count poll; hidden at zero, capped when large.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of navigation previously reachable from the top header (Workspaces, Human queue, Sign out) is reachable from the sidebar, and the top header is no longer present as a navigation surface.
- **SC-002**: On every in-app route, the sidebar highlights exactly the correct section (Workspaces for `/` and `/workspaces/*`, Human queue for `/human-queue`, none for unmatched routes) with zero mismatches across the tested routes.
- **SC-003**: The open-task badge on the Human queue icon matches the polled open count in 100% of tested cases, showing no badge when the count is zero and a capped value when large.
- **SC-004**: The pre-auth gate renders with no sidebar in 100% of tested cases, and the sidebar appears only after authentication.
- **SC-005**: Signing out from the sidebar clears the token, shows the gate, and hides the sidebar in 100% of tested cases.
- **SC-006**: No content overlaps the sidebar — the main content region begins at or beyond the sidebar's right edge on every rendered route.
- **SC-007**: An operator can identify each icon's destination via its hover tooltip without relying on any visible text label.

## Assumptions

- The existing open-count polling hook (`useHumanTaskCount`) is reused verbatim as the badge source; no new polling or endpoint is introduced.
- The feature 006 open>0 landing redirect logic is retained as-is and simply coexists with the new sidebar; this feature does not modify it.
- Icons come from the newly sanctioned lucide library via the `lucide-vue-next` package (the one new frontend dependency approved by the iteration 9 decision); tooltips use the existing Element Plus tooltip component.
- The brand mark is a compact glyph or single-letter "B" mark chosen to fit the ~70px width; the full wordmark is intentionally dropped in the sidebar.
- Active-section highlighting is derived from the current route, matching the route structure defined in feature 007 (workspace sub-routes under `/workspaces/:id`).
- Desktop-only: collapsible/expandable behavior and mobile/responsive layout are explicitly out of scope; the sidebar is a fixed-width fixture.
- No new navigation destinations are added; the sidebar exposes exactly the destinations that exist today.
- Theming changes are limited to what the sidebar itself requires (its own surface, active-state, and badge styling); no broader theme rework.

# Feature Specification: Home Dashboard

**Feature Branch**: `claude/home-dashboard-spec-5n1pyt`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Create a feature specification for a new Home dashboard page at `/home` in the BRIGADIR web app. A landing dashboard that answers at a glance: does the system need me, what is running right now, what broke while I was away, and what does it cost. MVP blocks: human queue hero widget, stat tiles row backed by one aggregate summary endpoint, cross-workspace 'needs attention' list (failed/timed_out in last 24h), cross-workspace live runs list (running/queued with live duration ticker), workspace cards grid with health aggregates, platform-wide total cost for 24h/7d/30d. `/home` becomes the landing page (`/` redirects to it, workspace list moves to `/workspaces`), Home entry added first in the sidebar. Visual reference: docs/mockups/home-dashboard.html (approximate layout sketch, not a pixel spec)."

**Visual reference**: `docs/mockups/home-dashboard.html` — authoritative for block composition and hierarchy (tiles row → human-queue hero + needs-attention column / live-runs + spend column → workspace grid), the fields each row shows, and the status→color mapping. Exact spacing, copy, and the fake data are directional only. The mock's hand-rolled app shell (including its collapse-to-top sidebar) is NOT part of this feature — the page renders inside the existing app shell, unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Land on Home and see what awaits me (Priority: P1)

An operator opens the dashboard (or returns to it after hours away). Instead of the workspace list, they land on a Home page whose most prominent block is the human queue: how many tasks are waiting on a human decision, and the oldest few of them — each with the ticket, the question summary, which agent asked, which workspace it belongs to, and how long it has been waiting. One click takes them to the full human queue or straight to the run that is blocked.

**Why this priority**: "Does the system need me?" is the single question the dashboard exists to answer — a blocked run wastes agent time and holds a ticket hostage until a human responds. This story also carries the routing change (Home becomes the landing page), which every other story renders inside.

**Independent Test**: With several human tasks pending across two workspaces, open the app root: verify it lands on Home, the hero widget shows the correct pending count and the oldest tasks first, and each row links to the blocked run while the widget header links to the full human queue. Deliverable on its own — even with only this block, the landing page already answers the most important question.

**Acceptance Scenarios**:

1. **Given** a logged-in operator and 3 pending human tasks, **When** they navigate to the app root `/`, **Then** they are taken to the Home page and the hero widget shows the count "3" and the 3 tasks, oldest waiting first, each with ticket key, task summary, agent, workspace, and waiting duration.
2. **Given** more pending tasks than the widget's fixed capacity (top 5), **When** Home renders, **Then** the widget shows the 5 oldest tasks and the full count, and its "open queue" link leads to the complete human queue page.
3. **Given** a pending human task row, **When** the operator activates it, **Then** they arrive at the existing run card / human-task detail where they can answer — no new answering UI on Home.
4. **Given** no pending human tasks, **When** Home renders, **Then** the hero shows an explicit calm empty state (count 0, "nothing waiting on you" style message) — not a blank area.
5. **Given** the old bookmarks, **When** an operator opens `/` or a link to the former workspace-list root, **Then** they are redirected without error: `/` lands on Home, and the workspace list is reachable at its new address and from the sidebar.
6. **Given** the sidebar, **When** any page renders, **Then** a Home entry appears as the first navigation item and behaves like its siblings (same hover treatment, active-state highlight on `/home`).

---

### User Story 2 - Read system state from the stat tiles (Priority: P2)

An operator glances at a row of four tiles at the top of Home: how many runs are running right now, how many are queued, how many finished `failed` or `timed_out` in the last 24 hours, and how many tasks await a human. All four numbers arrive together, so the row is never half-populated.

**Why this priority**: The tiles are the one-second summary of the whole system; every deeper block below elaborates on one of them. They come after US1 because the human queue hero already surfaces the most actionable number.

**Independent Test**: Seed a known mix of runs (e.g. 2 running, 1 queued, 1 failed 3h ago, 1 timed_out 30h ago) and 2 pending human tasks; open Home and verify the tiles read 2 / 1 / 1 / 2 — the 30h-old timeout excluded.

**Acceptance Scenarios**:

1. **Given** runs in various states across several workspaces, **When** Home renders, **Then** the tiles show: count of currently running runs, count of currently queued runs, combined count of runs that finished `failed` or `timed_out` within the last 24 hours, and the pending human-task count.
2. **Given** a run that failed 25 hours ago, **When** Home renders, **Then** it is NOT counted in the failed-24h tile.
3. **Given** all four counters, **When** the summary refreshes, **Then** they update together from a single aggregate response — the row never mixes counters from two different moments.
4. **Given** zero activity (no runs, no tasks), **When** Home renders, **Then** every tile shows 0 rather than an error or empty placeholder.
5. **Given** the failed-24h tile is non-zero, **Then** it is visually flagged with the danger state color; the running tile carries the same pulse indicator used by the running status tag elsewhere in the app.

---

### User Story 3 - See what broke while I was away (Priority: P2)

An operator returning after hours away scans a "Needs attention" list: runs that finished `failed` or `timed_out` within the last 24 hours, across ALL workspaces, most recent first. Each row shows the final status, ticket, agent, workspace, and when it finished — and clicking it opens the run card to diagnose.

**Why this priority**: "What broke while I was away?" is the second question the page exists to answer; failures are actionable (retry, fix, reassign) and currently require visiting each workspace's runs tab to discover.

**Independent Test**: With failed/timed_out runs spread over two workspaces (some older than 24h), open Home: verify only the last-24h ones appear, ordered most recently finished first, and a row click opens the correct run card.

**Acceptance Scenarios**:

1. **Given** runs finished `failed` or `timed_out` in the last 24h in two different workspaces, **When** Home renders, **Then** all of them appear in one list with status tag, ticket key, agent, workspace name, and relative finish time, ordered most recently finished first.
2. **Given** a run that failed more than 24 hours ago, **Then** it does not appear.
3. **Given** more qualifying runs than the list's fixed capacity (top 10), **Then** the list shows the 10 most recent and a "view all" style link leading to an existing runs view.
4. **Given** no failures in the last 24h, **Then** the block shows a positive empty state ("nothing broke in the last 24h" style), not a blank card.
5. **Given** a row, **When** clicked, **Then** the existing run card for that run opens.

---

### User Story 4 - Watch what is running right now (Priority: P3)

An operator sees a "Live runs" list: every `running` and `queued` run across all workspaces. Running rows show a live duration ticker that counts up between refreshes; queued rows show how long they have been waiting. Each row shows agent, ticket, and workspace, and links to the run card.

**Why this priority**: Answers "what is the system doing right now?" — valuable for supervision but less actionable than a human task or a failure; the counts are already visible in the tiles (US2).

**Independent Test**: With runs running and queued in two workspaces, open Home: verify all appear in one list, running rows tick forward every second without a network request, and rows link to their run cards.

**Acceptance Scenarios**:

1. **Given** running and queued runs across workspaces, **When** Home renders, **Then** they appear in one list — running rows first (longest-running on top), then queued rows (longest-waiting on top) — each with status tag, ticket, agent, and workspace.
2. **Given** a running row, **Then** its duration display ticks forward every second between data refreshes, anchored on the run's actual start time (same behavior as the existing runs list ticker), and the running tag carries the existing pulse indicator.
3. **Given** a run transitions (queued→running, running→finished), **When** the next poll lands, **Then** the list reflects the change without a page reload — finished runs leave the list.
4. **Given** no live runs, **Then** the block shows an idle empty state.
5. **Given** more live runs than the fixed capacity (top 10), **Then** the 10 highest-priority per the ordering above are shown plus a "view all" style link.

---

### User Story 5 - Scan workspace health cards (Priority: P3)

An operator scans a grid of workspace cards: each shows the workspace name, board key, paused/active state, agent count, its most recent run (status + relative time), and a danger marker when that workspace had failed or timed-out runs in the last 24 hours. Clicking a card opens the workspace.

**Why this priority**: Per-workspace drill-down orientation — useful, but the cross-workspace blocks above already surface everything urgent; this block mostly routes the operator to the right workspace.

**Independent Test**: With three workspaces (one paused, one with a 24h failure, one with no runs), open Home: verify each card's name/board/state/agent count/last-run/failure-marker are correct and cards navigate to the workspace.

**Acceptance Scenarios**:

1. **Given** several workspaces, **When** Home renders, **Then** each appears as a card with name, board key, paused/active state, agent count, and last run (status tag + relative time).
2. **Given** a workspace with at least one run finished `failed` or `timed_out` in the last 24h, **Then** its card carries a clearly visible danger marker naming the count; workspaces without such failures show a calm "no failures" note instead.
3. **Given** a paused workspace, **Then** its card is visibly distinguished (paused tag, muted treatment) per the mock.
4. **Given** a workspace that has never had a run, **Then** the last-run slot shows an explicit "no runs yet" state.
5. **Given** a card, **When** clicked, **Then** the existing workspace page opens.
6. **Given** no workspaces at all, **Then** the grid shows the existing empty-state guidance (create/onboard a workspace) rather than nothing.

---

### User Story 6 - Check platform-wide spend (Priority: P3)

An operator checks a Spend block showing the total cost across ALL workspaces for a selected period — 24h, 7d, or 30d — with the same period semantics as the existing per-workspace cost view. Switching period updates the figure without a page reload.

**Why this priority**: "What does it cost?" completes the dashboard's four questions but is informational — nothing on it demands action today.

**Independent Test**: With runs carrying known costs across two workspaces and periods, open Home: verify the 24h figure equals the cross-workspace sum for 24h and that switching to 7d/30d shows the matching sums.

**Acceptance Scenarios**:

1. **Given** runs with recorded costs in multiple workspaces, **When** Home renders, **Then** the Spend block shows the platform-wide total for the default period (24h), equal to the sum of the per-workspace figures for the same period.
2. **Given** the period switcher (24h / 7d / 30d), **When** the operator picks another period, **Then** the figure updates to that period's total without a full page reload.
3. **Given** no runs with cost in the selected period, **Then** the block shows a zero amount, not an error.
4. **Given** the existing per-workspace cost view, **Then** period boundaries and rounding on Home match it — the same run set produces consistent numbers in both places.

---

### Edge Cases

- **Consistency between blocks**: the tiles, hero, and lists poll independently, so for one refresh cycle the human-queue tile count and the hero count (or the running tile and the live-runs list) may briefly disagree. Acceptable within one poll interval; they must converge on the next refresh without user action.
- **24h boundary**: a run finishing at exactly the 24-hour boundary during a session — rows/counters drop out naturally on the next refresh; no client-side "expiry" logic beyond re-fetch.
- **Clock skew**: live tickers are anchored on server-provided timestamps; a client clock ahead/behind must not produce negative durations (clamp at zero, same as the existing runs ticker).
- **Overflowing lists**: every fixed top-N list must state or imply that more exist ("view all" link with total count where the data provides one); truncation must never look like the full picture.
- **Long content**: long ticket summaries, workspace names, or agent names must truncate within their row without breaking layout (per mock's ellipsis treatment).
- **Backend unreachable / summary fails**: each block degrades independently — a failed block shows an error state while the others render; one failing aggregate must not blank the whole page.
- **All workspaces paused**: tiles legitimately read 0 running / 0 queued; the page must read as "calm", not broken.
- **Redirect loops**: `/` → Home redirect must not interfere with deep links to existing pages (run cards, human queue, workspace tabs) or with the moved workspace list.

## Requirements *(mandatory)*

### Functional Requirements

**Routing & navigation**

- **FR-001**: The application MUST serve a new Home dashboard page at `/home`, and `/home` MUST be the landing destination: navigating to `/` redirects to `/home`.
- **FR-002**: The workspace list page MUST move to `/workspaces`; previously working links to the workspace list at the root MUST continue to resolve via redirect (no dead bookmarks).
- **FR-003**: The sidebar MUST gain a Home entry as the FIRST navigation item, visually and behaviorally consistent with existing entries (including the sidebar-only hover animation treatment); it MUST show the active state when the Home page is open.
- **FR-004**: The Home page MUST sit behind the existing shared dashboard authentication gate exactly like every other page — no special per-route access rules.

**Human queue hero (P1)**

- **FR-005**: Home MUST display a hero widget — the most visually prominent block — showing the total count of tasks awaiting a human and the oldest 5 pending tasks, oldest first.
- **FR-006**: Each hero row MUST show the ticket key, the task's question/summary, the requesting agent, the workspace, and the waiting duration; each row MUST link to the existing place where the task can be answered, and the widget MUST link to the full human queue page.
- **FR-007**: With zero pending tasks the hero MUST render an explicit positive empty state.
- **FR-008**: The hero MUST be populated from the existing human-task capabilities; this block introduces no new server-side behavior.

**Stat tiles (P2)**

- **FR-009**: Home MUST display a row of four stat tiles: currently running runs, currently queued runs, runs finished `failed` or `timed_out` within the last 24 hours (combined), and pending human tasks — all counted across ALL workspaces.
- **FR-010**: All tile counters MUST be delivered by ONE new aggregate summary response (`GET /api/home/summary`) so the row always reflects a single moment; the same response carries the platform spend figures (FR-021).
- **FR-011**: The failed-24h tile MUST use the danger state styling when non-zero; the running tile MUST reuse the established running-pulse indicator.

**Needs attention list (P2)**

- **FR-012**: Home MUST display a list of runs that finished `failed` or `timed_out` within the last 24 hours across ALL workspaces, ordered most recently finished first, capped at the 10 most recent, with a link to a fuller runs view.
- **FR-013**: Each row MUST show the final status, ticket key, agent, workspace, and relative finish time, and MUST link to the existing run card.
- **FR-014**: This list MUST be served by a new cross-workspace runs listing capability that REQUIRES a status filter and an item cap on every request — unbounded "all runs everywhere" listing MUST be impossible — and every query MUST have a deterministic order.

**Live runs list (P3)**

- **FR-015**: Home MUST display all currently `running` and `queued` runs across ALL workspaces in one list — running first (longest-running on top), then queued (longest-waiting on top) — capped at 10 rows with a "view all" style link when more exist.
- **FR-016**: Each row MUST show status, ticket key, agent, and workspace, and link to the run card; running rows MUST show a live duration that ticks forward every second between refreshes, anchored on the run's server-recorded start time (existing runs-list ticker behavior, clamped at zero against clock skew).
- **FR-017**: The live list MUST be served by the same cross-workspace runs listing as FR-014, invoked with the live statuses.

**Workspace cards (P3)**

- **FR-018**: Home MUST display every workspace as a card with: name, board key, paused/active state, agent count, last run (status + relative time, or an explicit "no runs yet"), and — when the workspace had `failed`/`timed_out` runs in the last 24 hours — a danger marker with the count.
- **FR-019**: Cards MUST link to the existing workspace page; paused workspaces MUST be visibly distinguished.
- **FR-020**: The per-workspace aggregates (agent count, last run, 24h failure count) MUST be delivered with the workspace listing data — the page MUST NOT fetch per-workspace details in a request-per-card pattern.

**Spend (P3)**

- **FR-021**: Home MUST display the platform-wide total cost (sum across all workspaces) for the periods 24h, 7d, and 30d, with a period switcher defaulting to 24h; period boundaries and semantics MUST match the existing per-workspace cost view so figures are mutually consistent.
- **FR-022**: A zero-spend period MUST display as a zero amount, not an empty or error state.

**Freshness & resilience**

- **FR-023**: All Home blocks MUST refresh automatically by polling at intervals consistent with existing dashboard pages; on refresh, lists MUST update in place (rows keep rendering from previous data while new data loads — no flicker to empty).
- **FR-024**: Each block MUST degrade independently on error: a failed data source shows an in-block error state while sibling blocks continue to render and refresh.

**Conventions & quality gates**

- **FR-025**: Home's fixed top-N lists are sanctioned whole-list consumers: they MUST NOT introduce pagination controls or paginated envelopes; capacity overflow is handled by the "view all" links.
- **FR-026**: All new response shapes MUST be defined as shared typed contracts (strict, snake_case) in the shared contracts package, consumed by both backend and web — never duplicated ad hoc; all status vocabulary and status→color mapping MUST reuse the existing run-status vocabulary and status tag component.
- **FR-027**: Visual conventions MUST hold: brand/state colors only via the established theme variables (no hardcoded hex), lucide icons static outside the sidebar, existing card/tag components rather than bespoke lookalikes.
- **FR-028**: Tests MUST land in the same iteration: contract tests for every new schema, backend integration tests for the new aggregate and cross-workspace listing behavior against real infrastructure, and web component tests for the new page's blocks following existing patterns.
- **FR-029**: The feature MUST NOT change the database schema. If detailed design discovers a schema change is unavoidable, work MUST stop and the conflict be flagged (architecture document governs schema changes).

### Key Entities

- **Home summary**: a single aggregate snapshot for the tiles and spend block — running count, queued count, failed+timed_out-in-24h count, pending-human-task count, and total cost per period (24h/7d/30d) across all workspaces.
- **Global run (list item)**: a run as seen from the cross-workspace perspective — status, ticket reference, agent reference, WORKSPACE reference (the new dimension vs. the existing workspace-scoped list), start/finish timestamps for tickers and relative times.
- **Pending human task (existing)**: a question from an agent awaiting a human decision — ticket, summary, agent, workspace, created/waiting-since time; reused as-is.
- **Workspace card summary**: a workspace enriched with dashboard aggregates — agent count, last run (status + finished/started time), and count of failed/timed_out runs in the last 24h.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator landing on the app answers all four questions — anything waiting on me, what's running, what broke in the last 24h, what it costs — from ONE screen with ZERO additional navigation (today: visiting every workspace's runs tab plus the human queue, ≥ 2·N pages for N workspaces).
- **SC-002**: Every item shown on Home (human task, run row, workspace card) reaches its existing detail page in exactly one click; Home introduces no dead ends.
- **SC-003**: Data on Home is never staler than one polling interval of the respective block, and a run state change (start, finish, human-task creation) appears on Home within one interval without user action.
- **SC-004**: Home's figures are consistent with the pages it summarizes: tile counts match the corresponding filtered lists, and platform spend equals the sum of the per-workspace spend figures for the same period, 100% of the time at any single refresh moment.
- **SC-005**: The page renders its initial content within the same perceived-latency envelope as existing dashboard pages, with a bounded number of data requests independent of workspace count (no per-workspace fan-out from the browser).
- **SC-006**: Pre-existing links and bookmarks keep working after the routing change: `/` and old workspace-list links resolve correctly, 0 broken routes.
- **SC-007**: All acceptance scenarios above are covered by automated tests (contract, backend integration, web component) merged in the same change.

## Assumptions

- **Top-N sizes**: human queue hero shows the 5 oldest pending tasks; needs-attention and live-runs lists cap at 10 rows. Within the requested 5–10 band; planning may tune within that band without spec change.
- **Ordering defaults**: human queue oldest-first (matches the existing queue's server ordering); needs attention most-recently-finished first; live runs running-before-queued, each longest-active first. All orderings deterministic with a stable tie-breaker.
- **Spend defaults**: default period 24h (mock's default); amounts in the same currency/format as the existing per-workspace cost view. The mock's secondary spend line (run count, average per run) is directional — included only if the aggregate data yields it for free; the total figure is the requirement.
- **Tile sub-captions**: the mock's tile sub-lines ("across 2 workspaces", "next: PAY-152", "oldest waiting 3h 12m") are directional nice-to-haves, not required content; the four counters are the requirement.
- **Workspace grid size**: the grid shows ALL workspaces without a cap — this is an internal tool with a small workspace population; the existing workspace-list ordering is reused. If the population ever grows large, the "all workspaces" link already provides the escape hatch.
- **Human-queue block reuses existing endpoints** (count + list) as stated in the request; the summary endpoint independently includes the pending-task counter so the tiles arrive atomically — brief divergence between the two sources within a poll cycle is acceptable (see Edge Cases).
- **Workspace aggregates delivery**: whether the existing workspace listing is extended or a dedicated summary endpoint is added is a planning decision; the spec constraint is only "no request-per-card fan-out" (FR-020) and no pagination change to the sanctioned whole-list pattern already used by pickers.
- **Polling intervals** follow the precedents already in the app (runs list / human queue pages); no new real-time push of any kind.
- **No new write operations**: Home is read-only; answering tasks, retrying runs, pausing workspaces all continue to happen on their existing pages.
- **Out of scope confirmed**: charts/sparklines, success-rate and duration trends, retry-pressure stats, per-agent cost breakdown, Jira activity feed, real-time push.

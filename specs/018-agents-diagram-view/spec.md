# Feature Specification: Agents Diagram View Mode

**Feature Branch**: `claude/agents-diagram-view-mode-832dbb`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Add a diagram view mode to the workspace Agents page (route `/workspaces/:id/agents`). The page gets a List/Diagram toggle; Diagram renders an interactive directed graph of the agent pipeline over the live Jira board statuses — agent nodes and status nodes, with trigger edges (status → agent) and success/failure outcome edges (agent → status). Orchestrator and disabled agents are hidden; statuses referenced by no visible agent are rendered muted. A '+' on status nodes opens the existing AgentForm with trigger_status pre-filled; agent nodes carry an edit button opening the existing edit form. The diagram is pure derived client state over the existing agents and statuses queries — no new backend, no persistence of view mode or node positions." (Full text, including decided architecture constraints, in the `/speckit-specify` invocation.)

## Context

The pipeline in BRIGADIR is emergent: it is not stored anywhere, it arises from each agent's `trigger_status`, `status_success`, and `status_failure` bindings to the Jira board's workflow statuses (Constitution, Principle I). Today the only way to understand a workspace's pipeline is to read the agents table row by row and mentally reconstruct the graph. The diagram view makes the emergent pipeline visible: which status feeds which agent, where the ticket goes on success and on failure, which statuses are dead ends, and where the loops are.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Toggle to Diagram and read the pipeline at a glance (Priority: P1)

An operator opens a workspace's Agents page and sees the familiar table (List mode, the default). They switch the view toggle to "Diagram" and get an interactive graph laid out left-to-right: the board's workflow statuses and the workspace's worker agents as nodes, connected by edges that show what triggers each agent and where tickets land on success or failure. They pan and zoom to inspect a large pipeline, and can drag a node aside to untangle a crossing — nothing they do to the layout is saved. Switching back to List returns the unchanged table; revisiting the page later always starts in List again.

**Why this priority**: The read-only graph is the entire value proposition — turning a flat roster into a legible pipeline picture. Every other story (create from the diagram, edit from the diagram) decorates this canvas; without it there is nothing to decorate.

**Independent Test**: Seed a workspace with a known roster (a chain of 2–3 agents, one disabled agent, the orchestrator, one JQL-only agent, one status referenced by nobody) and switch to Diagram: verify the graph shows exactly the expected nodes and edges per the semantics below. Deliverable on its own as a read-only visualization.

**Acceptance Scenarios**:

1. **Given** the Agents page, **When** it first renders (or is revisited in a new navigation), **Then** it shows the existing table in List mode with a visible List/Diagram toggle — the choice is never restored from a previous visit.
2. **Given** an agent with `trigger_status: "To Do"`, `status_success: "In Review"`, `status_failure: "Blocked"`, **When** Diagram mode renders, **Then** the agent node has an incoming edge from the "To Do" status node, a solid success-styled edge to "In Review", and a dashed danger-styled edge to "Blocked".
3. **Given** agent A with `status_success: "Done"` and agent B with `status_failure: "Done"`, **When** the diagram renders, **Then** exactly one "Done" status node exists and both edges converge on it.
4. **Given** a workspace whose agents form a cycle (A succeeds into B's trigger status, B fails back into A's trigger status), **When** the diagram renders, **Then** all nodes and edges are laid out and reachable without overlap that hides any node, and the page does not error.
5. **Given** the orchestrator agent (`is_orchestrator=true`) and a disabled agent (`enabled=false`), **When** the diagram renders, **Then** neither appears as a node, and no edges are drawn for them.
6. **Given** an enabled agent with `trigger_jql` only (`trigger_status` empty), **When** the diagram renders, **Then** its node appears with no incoming trigger edge and carries a "JQL" badge whose tooltip shows the JQL text.
7. **Given** an agent with both `trigger_status` and `trigger_jql`, **When** the diagram renders, **Then** the trigger edge is drawn AND the JQL badge (with tooltip) is present.
8. **Given** a board status referenced by no visible agent, **When** the diagram renders, **Then** the status node is still shown, visually muted/dimmed relative to referenced statuses.
9. **Given** two agents triggered from the same status (disambiguated by their JQL filters), **When** the diagram renders, **Then** both trigger edges fan out from that one status node.
10. **Given** the rendered diagram, **When** the operator pans, zooms, or drags a node, **Then** the view responds; **When** they leave and return to Diagram mode, **Then** the layout is freshly computed — no positions were saved.
11. **Given** a user with reduced-motion preference, **When** the diagram renders or updates, **Then** no non-essential animation plays.
12. **Given** the agents or statuses request is still loading, **Then** Diagram mode shows the app's standard loading treatment; **Given** the statuses request fails (e.g. Jira unreachable), **Then** Diagram mode shows an error state instead of a partial or empty graph.

---

### User Story 2 - Grow the pipeline from a status node (Priority: P2)

Looking at the diagram, an operator spots a status where tickets land but nothing picks them up (a success target with no outgoing agent, or a muted unbound status). They click the "+" affordance on that status node; the existing agent creation dialog opens with the trigger status already set to that status. They complete the form as usual — same validation, lint warnings, and error handling as from the list — and on save the dialog closes and the diagram redraws itself with the new agent node and its edges, without a manual refresh.

**Why this priority**: This turns the diagram from a picture into a workbench — the natural "what happens next?" gesture when reading a pipeline is attaching the next agent to the status where tickets pile up. It depends on US1's canvas.

**Independent Test**: From a diagram with a status that has an incoming success edge and no outgoing trigger edge, click its "+", verify the create dialog opens with that status pre-selected as trigger, save a valid agent, and verify the new node and its three edges appear without reloading the page.

**Acceptance Scenarios**:

1. **Given** a status node, **When** the operator activates its "+" affordance, **Then** the existing agent creation dialog opens with `trigger_status` pre-filled to that status and every other field in its usual default state.
2. **Given** the pre-filled dialog, **When** the operator submits and the server rejects the config (validation/lint error), **Then** the same error presentation as list-mode creation is shown and the dialog stays open.
3. **Given** the pre-filled dialog, **When** the operator saves successfully, **Then** the dialog closes and the diagram re-renders to include the new agent and its edges — with no page reload and no extra manual action.
4. **Given** a save from the diagram, **When** the operator switches to List mode, **Then** the new agent is present in the table without any additional fetch being triggered by the mode switch itself.
5. **Given** the operator cancels the dialog, **Then** the diagram is unchanged.

---

### User Story 3 - Edit an agent from its node (Priority: P3)

While reading the diagram, an operator notices an agent whose failure status is wrong. They click the edit button on that agent's node; the existing edit dialog opens for exactly that agent, behaving identically to the Edit action in the table. After saving, the diagram redraws — the corrected edge now points at the new status.

**Why this priority**: Completes the round trip (read → fix → see the fix) but is a convenience over an existing path — the operator could always switch to List and edit there.

**Independent Test**: Click edit on an agent node, verify the edit dialog opens loaded with that agent's data, change `status_failure`, save, and verify the failure edge re-targets on the diagram without a page reload.

**Acceptance Scenarios**:

1. **Given** an agent node, **When** the operator activates its edit button, **Then** the existing agent edit dialog opens for that agent, identical in behavior to the table's Edit action.
2. **Given** a successful edit that changes a trigger or outcome status, **When** the dialog closes, **Then** the diagram reflects the new edges automatically.
3. **Given** an edit that disables the agent, **When** the dialog closes, **Then** the agent's node and edges disappear from the diagram, and statuses it alone referenced become muted.

---

### Edge Cases

- **Empty roster**: workspace has statuses but no visible worker agents (all disabled, or only the orchestrator) → the diagram shows only muted status nodes plus an empty-state hint, not an error or a blank canvas.
- **No statuses**: statuses endpoint returns an empty list (misconfigured board) → diagram shows an explicit empty/error state; JQL-only agents may still render as unconnected nodes.
- **Stale status reference**: an agent's `trigger_status`, `status_success`, or `status_failure` names a status that is not in the live board statuses (workflow changed after the agent was configured) → the referenced status is still rendered as a node so the edge has an endpoint, visually marked as missing from the board (distinct from muted); the edge is drawn normally.
- **Self-loop**: an agent whose success (or failure) status equals its own trigger status → renders as a status→agent→same-status loop without breaking layout.
- **Large fan-out/fan-in**: many agents triggered from one status, or many outcome edges converging on one status → edges remain individually distinguishable (hover/selection or spacing), layout does not stack nodes on top of each other.
- **Rapid mode toggling**: flipping List↔Diagram repeatedly must not fire new network requests per flip — both modes read the same already-cached data.
- **Concurrent change elsewhere**: an agent is edited in another tab/session → the diagram updates whenever the underlying shared queries refresh, with no diagram-specific staleness handling.

## Requirements *(mandatory)*

### Functional Requirements

**View mode**

- **FR-001**: The workspace Agents page MUST offer exactly two display modes, "List" and "Diagram", switchable via a toggle on the page; List is the existing table, unchanged.
- **FR-002**: The default mode MUST be List on every fresh visit to the page; the chosen mode MUST NOT be persisted anywhere (no local storage, no server state).
- **FR-003**: Switching modes MUST NOT trigger additional data fetches beyond what the page already loads — both modes MUST derive from the same shared agents and statuses data.

**Graph semantics**

- **FR-004**: Diagram mode MUST render a directed graph with two node kinds: one node per live board workflow status, and one node per visible worker agent.
- **FR-005**: For every visible agent the diagram MUST draw: a solid success-styled edge from the agent to its `status_success` node, and a dashed danger-styled edge from the agent to its `status_failure` node.
- **FR-006**: For every visible agent with a `trigger_status`, the diagram MUST draw a trigger edge from that status node to the agent node.
- **FR-007**: Each board status MUST appear as exactly one node; all edges referencing the same status MUST share that node.
- **FR-008**: Agents with `trigger_jql` MUST carry a visible "JQL" badge on their node; the badge MUST expose the JQL text (e.g. via tooltip). Agents with only `trigger_jql` (no `trigger_status`) MUST render with no incoming trigger edge.
- **FR-009**: The layout MUST handle general directed graphs — cycles, self-loops, fan-out and fan-in — without rendering failures or hidden nodes.

**Visibility rules**

- **FR-010**: The orchestrator agent (`is_orchestrator=true`) MUST NOT appear in the diagram.
- **FR-011**: Disabled agents (`enabled=false`, including soft-deleted) MUST NOT appear in the diagram, nor any of their edges.
- **FR-012**: Board statuses referenced by no visible agent MUST still render, visually muted/dimmed.
- **FR-013**: A status referenced by a visible agent but absent from the live board statuses MUST still render as a node (so its edges have an endpoint), visually marked as missing from the board — distinguishable from both normal and muted statuses.

**Interactions**

- **FR-014**: The diagram MUST support pan and zoom. Node dragging MAY be supported for ad-hoc inspection; node positions MUST NOT be persisted — every render recomputes the automatic layout.
- **FR-015**: Status nodes MUST expose a "+" affordance that opens the existing agent creation dialog with `trigger_status` pre-filled to that status; all other dialog behavior (validation, server-side lint, error handling, warnings) MUST be identical to creation from the list.
- **FR-016**: Each agent node MUST expose an edit button that opens the existing agent edit dialog for that agent, identical in behavior to the table's Edit action.
- **FR-017**: After any successful create or edit, the diagram MUST re-render to reflect the change automatically via the shared data layer's invalidation — no manual refresh, no diagram-specific refresh machinery.

**States & conventions**

- **FR-018**: Diagram mode MUST present loading, error, and empty states: standard loading treatment while data loads; an explicit error state if either underlying query fails; an explicit empty-state hint when there are no visible agents.
- **FR-019**: All diagram styling MUST follow the app's existing UI conventions: brand/status colors only via the theme's semantic color variables, static icons from the app's icon set, and reduced-motion preference respected for any transition or animation.

### Key Entities

- **Status node**: one live Jira board workflow status (or a stale referenced status, marked missing). States: normal (referenced by ≥1 visible agent), muted (unreferenced), missing (referenced but not on the board). Carries the "+" create affordance.
- **Agent node**: one visible worker agent (enabled, non-orchestrator). Shows the agent's identity, an edit affordance, and a JQL badge when `trigger_jql` is set.
- **Trigger edge**: status → agent, from `trigger_status`. At most one per agent; absent for JQL-only agents.
- **Outcome edges**: agent → status; exactly two per visible agent — success (solid, success styling) from `status_success` and failure (dashed, danger styling) from `status_failure`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any workspace roster, an operator can answer "what triggers agent X and where do its tickets go on success/failure" from the diagram alone, without opening the agent's form or reading the table.
- **SC-002**: A realistic maximum roster (20 agents over ~15 board statuses, including at least one cycle and one fan-out) renders fully legible — every node reachable via pan/zoom, no permanently hidden elements — with the diagram appearing within 1 second of toggling once data is already loaded.
- **SC-003**: Creating an agent from a status node requires fewer inputs than from the list: the trigger status arrives pre-filled, and the operator never re-selects it.
- **SC-004**: 100% of successful creates/edits made from either view are reflected in the other view without a page reload or manual refresh.
- **SC-005**: Switching between List and Diagram any number of times generates zero additional server requests beyond the page's normal data loading and cache refreshes.
- **SC-006**: The graph-building rules (visibility, edge derivation, muted/missing statuses, cycle tolerance) are covered by automated component tests, and the create/edit/toggle interactions by automated interaction tests, all passing in CI.

## Assumptions

- **"+" appears on every status node** (outcome targets, trigger-only sources, and muted unbound statuses alike). The description explicitly requires it on success/failure targets and separately calls muted statuses "candidates for attaching new agents"; a uniform affordance satisfies both readings and avoids an arbitrary distinction. If it must be restricted to outcome-target statuses only, that is a one-line predicate change.
- **JQL badge lives on the agent node** (not the edge). The description allows either; the node placement also covers JQL-only agents, which have no trigger edge to badge.
- **Stale status references render as "missing" nodes** (edge kept, node marked) rather than dropping the edge or the agent — an operator must be able to see that an agent points at a status the board no longer has.
- Worker-agent roster fits one page: the diagram consumes the whole-list convention (single page of up to 100; roster is capped at 20), so no multi-page assembly is needed.
- The existing agent creation/edit dialog accepts a pre-filled trigger status without modification to its contract; only its invocation gains an initial value.
- Read-only diagram; no board or agent mutation happens from the canvas itself — all writes go through the existing dialog and its existing endpoints. No backend, schema, or API changes of any kind (decided constraint).
- Rendering approach, layout engine, and data-derivation architecture are pre-decided by the feature description (client-side derived state over the two existing queries; graph library with automatic left-to-right layout) and are recorded for the planning phase, not revisited here.

## Out of Scope (deferred by the feature description)

- Live run state on the diagram (highlighting/animating agents with active runs).
- "Attach an existing agent" to a status (re-pointing `trigger_status` from the graph).
- Persisting node positions or the view-mode choice.
- Any backend or schema changes.

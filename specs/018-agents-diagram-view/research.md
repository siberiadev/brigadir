# Research: Agents Diagram View Mode

**Feature**: 018-agents-diagram-view | **Date**: 2026-07-17

No NEEDS CLARIFICATION markers existed in the Technical Context; research resolves library integration patterns, query-sharing mechanics, testing strategy for a canvas library under jsdom, and the micro-decisions the spec delegated to planning.

## R1. Graph rendering: Vue Flow + dagre integration pattern

**Decision**: `@vue-flow/core` as the canvas with two custom node types (`agent`, `status`) registered via the `:node-types` API as Vue SFCs; `@dagrejs/dagre` computes positions in a plain function `layoutGraph(nodes, edges)` called inside the same computed that builds the graph — `rankdir: 'LR'`, fixed node dimensions fed to dagre (agent ≈ 200×84, status ≈ 160×56), `nodesep/ranksep` tuned once. Nodes/edges are passed to `<VueFlow :nodes :edges>` as controlled props recomputed from query data; no imperative store mutation for data changes (drag positions live only in Vue Flow's internal state and are discarded on recompute — exactly the "not persisted" requirement). Import `@vue-flow/core/dist/style.css` (base styles) once in the diagram component; skip `@vue-flow/background`/`minimap`/`controls` sub-packages — pan/zoom is built into core, and extra chrome is scope creep.

**Rationale**: This is the canonical Vue Flow + dagre recipe (their official layouting example); dagre is the only pre-decided layout engine and its layered LR output matches "pipeline over statuses" reading order. Controlled-props + pure layout keeps the entire graph a `computed` over the two queries — the spec's derived-state constraint verbatim — and makes re-render-on-invalidation (FR-017) automatic.

**Alternatives considered**: `useLayout` composable with Vue Flow store access — more moving parts, harder to unit test; ELK.js layout — better orthogonal routing but a heavyweight async WASM-ish dep, rejected (dagre is decided anyway); rolling our own SVG — rejected, pan/zoom/edge-routing is exactly the wheel Vue Flow provides.

## R2. Data sourcing & query-key sharing (no refetch storms)

**Decision**: The diagram consumes `useAgents(workspaceId, { page: 1, page_size: MAX_PAGE_SIZE })` — the *identical* params object shape `AgentForm` already uses for its linter roster, so both resolve to the same TanStack cache entry (`['agents', wsId, {page:1,page_size:100}]`). Statuses come from `useStatuses(workspaceId)` **without** `refresh: true` — the cached board snapshot; `AgentForm` keeps issuing its own `refresh: true` fetch on dialog open (unchanged), which repopulates the same `statusesKey` cache and thereby also freshens the diagram. Mode toggle is a local `ref<'list' | 'diagram'>('list')` in `AgentsList.vue`; both subtrees stay driven by already-mounted queries, so toggling triggers zero new requests (FR-003, SC-005). The List table keeps its paginated `useAgents(props.id, params)` query untouched.

**Rationale**: Query-key identity is the whole consistency story (spec: "List↔diagram consistency comes for free from shared TanStack Query keys") — `useCreateAgent`/`useUpdateAgent` already invalidate the `['agents', wsId]` prefix, which sweeps both the paginated list query and the whole-list diagram query at once. Reusing the AgentForm's exact whole-list params means the diagram usually renders from cache instantly.

**Alternatives considered**: A dedicated diagram query with its own key — violates the shared-key consistency constraint and double-fetches; `refresh: true` for the diagram's statuses — hammers Jira on every mount for no user-visible gain (the form already refreshes on the interaction that needs freshness).

## R3. Testing a canvas library under jsdom

**Decision**: Two-layer strategy. (1) **Semantics** — all spec graph rules (visibility, edge derivation, muted/missing statuses, JQL badge flags, cycle/self-loop tolerance) live in pure `buildGraph.ts` and are tested as plain functions in `agents-diagram-graph.spec.ts` — no DOM, no Vue Flow. (2) **Interactions** — `agents-diagram-view.spec.ts` mounts `AgentsList.vue` with msw-faked `/api/*` and **stubs the `<VueFlow>` component** (renders default slot / node components directly), then asserts: toggle defaults to List, switching renders the diagram wrapper without new agent-list requests (count msw hits), StatusNode "+" click emits up and opens the dialog with the pre-filled trigger select, AgentNode edit click opens the edit dialog. `test/setup.ts` gains a `ResizeObserver` polyfill guard (jsdom lacks it; Vue Flow requires it when not stubbed — `AgentNode`/`StatusNode` mounted directly need only the stub-level environment).

**Rationale**: Vue Flow's real rendering needs layout measurements jsdom can't produce; asserting SVG edge paths in jsdom tests brittleness, not behavior. The pure-function layer carries every normative graph rule from the spec (SC-006), and the stub layer proves the wiring (events → dialog → invalidation) — which is what can actually break. This mirrors the repo's existing pattern (presenter/pure-logic specs like `run-timeline-presenter.spec.ts` + component specs with msw).

**Alternatives considered**: Full Vue Flow mount in jsdom with ResizeObserver/DOMMatrix mocks — flaky and asserts library internals; Playwright e2e — no e2e harness exists in this repo, out of scope for a UI iteration.

## R4. Pre-filling the existing AgentForm

**Decision**: Add one optional prop to `AgentForm.vue`: `initialTriggerStatus?: string`. It participates only in the form's initial `reactive` seed for **create** mode: `trigger_status: a?.trigger_status ?? props.initialTriggerStatus ?? ''`. Nothing else changes — validation, client linter mirror, server 422 re-pinning, warnings, `status_ids` mapping all operate on `form.trigger_status` exactly as today. `AgentsList.vue` sets a `createTriggerStatus` ref from the diagram's `create-agent` event and passes it down; the existing `:key="editing?.id ?? 'new'"` remount already guarantees a fresh seed per dialog open (extend the key with the prefill value so consecutive "+" clicks on different statuses re-seed).

**Rationale**: Smallest possible contract change; the form remains the single owner of agent-write behavior (spec FR-015 "identical to creation from the list"). The seed-only approach means a user can still change the pre-filled status freely.

**Alternatives considered**: A generic `initialValues: Partial<AgentWriteRequest>` prop — YAGNI, wider surface to keep honest; emitting into the form post-mount via exposed method — fights the `reactive` seed and the remount key.

## R5. Status identity, muting, and "missing" nodes

**Decision**: Status nodes are keyed by **status name** (`node.id = 'status:' + name`): agents reference statuses by name (`trigger_status`/`status_success`/`status_failure` are name strings in `AgentResponse`); board names are unique per board. `BoardStatus.statusCategory` rides along as node data for possible subtle tinting but drives no logic. A status node's `kind` is: `'missing'` if referenced by a visible agent but absent from the live statuses list (rendered with a danger-tinted outline + an icon, edge kept — FR-013); `'muted'` if present on the board but referenced by zero visible agents (dimmed — FR-012); `'normal'` otherwise. **`status_running` is deliberately not visualized**: the spec's edge model (decided) covers trigger/success/failure only; a status that is only someone's `status_running` counts as *unreferenced* and renders muted. This is recorded here so nobody "fixes" it as a bug.

**Rationale**: Name-keying matches the data model the pipeline actually runs on (Principle I: bindings are by observed status), and dedupes convergent edges onto one node (FR-007) with zero lookup machinery. `status_running` is a transient parking state, not a pipeline edge — drawing it would double the edge count and muddy the success/failure reading.

**Alternatives considered**: Keying by Jira status id — breaks for missing statuses (no id exists) and buys nothing; hiding missing-status references — hides real drift the operator must see; drawing `status_running` edges — rejected as above.

## R6. Mode toggle, node/edge styling, theming, motion

**Decision**:
- **Toggle**: `el-segmented` (Element Plus ≥2.7, available in 2.9) with two options labeled by static lucide icons + text: `List` (lucide `List`) / `Diagram` (lucide `Workflow`). Local ref, default `'list'`, never persisted (FR-002). No `AnimatedIcon` wrapper — hover animation is sidebar-only per UI convention.
- **Edges**: success = solid, `stroke: var(--el-color-success)`; failure = dashed (`stroke-dasharray`), `stroke: var(--el-color-danger)`; trigger = solid, `stroke: var(--el-color-primary)` with an arrow marker. Colors exclusively through `--el-color-*` tokens so both themes work with zero extra code; no Vue Flow `animated` edges (they're marching-ants animation — gratuitous, and would need reduced-motion gating anyway).
- **Nodes**: Element-Plus-styled cards — agent node: name, role tag (reuses the list's `el-tag` look), edit `el-button` (lucide `Pencil`), `el-tag` "JQL" badge wrapped in `el-tooltip` carrying the raw JQL; status node: name + `Plus` icon button; muted via reduced opacity + `--el-text-color-secondary`; missing via `--el-color-danger` outline and a `TriangleAlert` icon with tooltip.
- **Motion**: the only transitions are Vue Flow's zoom/pan easing and any hover elevation; wrap ours in `@media (prefers-reduced-motion: reduce)` overrides (FR-019). No entrance animations.
- **States**: `v-loading` (standard EP spinner, auto-primary) while either query loads; `el-alert`-based error state when either query errors (statuses query has `retry: false`, so Jira-down surfaces immediately); `el-empty`-based hint when no visible worker agents exist.

**Rationale**: Every visual choice maps to an existing repo convention (2026-07-15/16 decisions) — theme tokens only, static lucide icons, standard EP spinner. Segmented control is the EP-native pattern for exclusive view modes.

**Alternatives considered**: `el-radio-group` button style — works, but segmented is the closer semantic and newer EP standard; custom CSS colors for edges — forbidden by the palette rule.

## R7. Dependency choice & versions

**Decision**: Add to `apps/web` only: `@vue-flow/core@^1.42` and `@dagrejs/dagre@^1.1`. Both ship ESM, tree-shake into the existing Vite build, and are lazy-loaded with the route chunk (AgentsList is already a dynamic import; the diagram component adds them to that chunk — optionally behind `defineAsyncComponent` if chunk size warrants, decided at implementation).

**Rationale**: Decided by the feature description; pinning caret ranges matches the repo's dependency style. Client-only — the fixed backend stack (constitution Technology Constraints) is untouched.

**Alternatives considered**: None — library selection was explicitly out of bounds ("decided — do not revisit").

# Tasks: Agents Diagram View Mode

**Input**: Design documents from `/specs/018-agents-diagram-view/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/components.md, quickstart.md

**Tests**: Included — the spec explicitly requests them (Testing section, SC-006): graph-derivation semantics as unit tests, interactions as component tests. No pipeline logic is touched (constitution VI UI-exemption applies), but tests ship in the same iteration per repo rule 4.

**Organization**: Tasks are grouped by user story. US1 (read-only diagram) is the MVP; US2 and US3 layer interactive affordances onto US1's canvas (the spec declares this dependency) and are independent of each other.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 (toggle + read-only graph), US2 (create from status node), US3 (edit from agent node)

## Path Conventions

Web-frontend-only feature: everything under `apps/web/` (Vue 3 dashboard in the pnpm monorepo). No backend, contracts-package, or worker paths.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and test-environment groundwork for the canvas library

- [X] T001 Add `@vue-flow/core` (^1.42) and `@dagrejs/dagre` (^1.1) to `apps/web/package.json` dependencies and run `pnpm install` (research R7; client-only, no backend stack change)
- [X] T002 [P] Add a `ResizeObserver` polyfill guard to `apps/web/test/setup.ts` (jsdom lacks it; needed once node components mount under test — research R3). Keep the existing msw lifecycle untouched.

**Checkpoint**: `pnpm --filter @brigadir/web typecheck` passes with the new deps resolvable.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None beyond Setup — this feature has no shared infrastructure to build first. The semantic core (`buildGraph`) belongs to US1, which every later story builds on; US1 itself is the foundation.

*(No tasks — proceed to Phase 3.)*

---

## Phase 3: User Story 1 - Toggle to Diagram and read the pipeline at a glance (Priority: P1) 🎯 MVP

**Goal**: List/Diagram toggle on `/workspaces/:id/agents` (List default, never persisted) and a read-only interactive graph: status + agent nodes, trigger/success/failure edges, visibility rules (orchestrator/disabled hidden, muted unbound statuses, missing stale references), JQL badges, pan/zoom, cycle-tolerant LR layout, loading/error/empty states, theme tokens, reduced motion.

**Independent Test**: Seed msw with a known roster (chain of agents, one disabled, the orchestrator, a JQL-only agent, an unreferenced status, a stale reference, a cycle) and assert the toggle defaults to List, the diagram renders exactly the expected nodes/edges, and toggling fires no new `/api/agents` request.

### Tests for User Story 1 (write first — must FAIL before implementation) ⚠️

- [X] T003 [P] [US1] Write `buildGraph` unit tests in `apps/web/test/agents-diagram-graph.spec.ts`: orchestrator hidden (FR-010); disabled hidden incl. their edges (FR-011); exactly two outcome edges per visible agent, solid-success / dashed-danger kinds (FR-005); trigger edge from `trigger_status` (FR-006); convergent references share one status node (FR-007); JQL-only agent → no incoming edge + `jql` set, JQL+trigger → both (FR-008); unreferenced board status → `kind: 'muted'` (FR-012); referenced-but-absent status → `kind: 'missing'`, edge kept (FR-013); `status_running` never counts as referenced (research R5); cycle and self-loop inputs don't throw and yield complete edge sets (FR-009); deterministic output ordering (data-model rule 6); empty roster → only muted statuses, `visibleAgentCount === 0`
- [X] T004 [P] [US1] Write toggle/rendering interaction tests in `apps/web/test/agents-diagram-view.spec.ts` (msw-faked `/api/agents` + `/api/workspaces/:id/statuses`, `<VueFlow>` stubbed — research R3): page defaults to List with `data-test="view-mode-toggle"` present (FR-001/002); switching to Diagram renders the diagram wrapper and back; an msw hit-counter proves the toggle itself fires no additional `/api/agents`/`/statuses` requests (FR-003, SC-005); statuses-query error → error state, not a partial graph; empty visible roster → empty-state hint (FR-018)

### Implementation for User Story 1

- [X] T005 [US1] Implement `apps/web/src/components/AgentsDiagram/buildGraph.ts`: `GraphModel`/node/edge types from data-model.md, pure `buildGraph(agents, statuses)` per derivation rules 1–6, plus exported `layoutGraph(model)` wrapping `@dagrejs/dagre` (`rankdir: 'LR'`, fixed node dimensions, stable ordering) that fills node positions (research R1). Make T003 pass.
- [X] T006 [P] [US1] Create `apps/web/src/components/AgentsDiagram/StatusNode.vue`: status name display; `kind` styling — normal, muted (reduced opacity + `--el-text-color-secondary`), missing (`--el-color-danger` outline + static lucide `TriangleAlert` with tooltip); colors ONLY via `--el-color-*` tokens; `data-test="diagram-status-node"` (no "+" yet — that is US2)
- [X] T007 [P] [US1] Create `apps/web/src/components/AgentsDiagram/AgentNode.vue`: agent name + role `el-tag`; `data.jql` → "JQL" `el-tag` in `el-tooltip` with raw JQL text, `data-test="agent-jql-badge"`; `data-test="diagram-agent-node"`; static lucide icons only (no edit button yet — that is US3)
- [X] T008 [US1] Create `apps/web/src/components/AgentsDiagram/AgentsDiagram.vue`: props/emits per contracts/components.md §2; `computed(() => layoutGraph(buildGraph(props.agents, props.statuses)))` into `<VueFlow>` with `node-types` {status, agent}; import `@vue-flow/core/dist/style.css`; edge styling by kind (trigger solid `--el-color-primary` + arrow, success solid `--el-color-success`, failure dashed `--el-color-danger`; no `animated` edges); pan/zoom on, positions never persisted (FR-014); `v-loading` / `el-alert` error / `el-empty` empty states (FR-018); `prefers-reduced-motion` override for any transition (FR-019)
- [X] T009 [US1] Integrate into `apps/web/src/views/AgentsList.vue`: `mode` ref default `'list'` (no persistence — FR-002); `el-segmented` toggle with static lucide `List`/`Workflow` icons, `data-test="view-mode-toggle"` (research R6); add `useAgents(props.id, { page: 1, page_size: MAX_PAGE_SIZE })` (identical key shape to AgentForm's — research R2) + `useStatuses(props.id)` (no refresh); render `<AgentsDiagram>` vs the existing table by mode, passing `agents`/`statuses`/`loading`/`error`; paginated list query and pagination untouched in List mode
- [X] T010 [US1] Verify: T003 + T004 green; `pnpm --filter @brigadir/web typecheck` and `pnpm lint` clean; quickstart walk steps 1–6 by hand against the dev stack

**Checkpoint**: Read-only diagram fully functional — MVP shippable.

---

## Phase 4: User Story 2 - Grow the pipeline from a status node (Priority: P2)

**Goal**: "+" on every status node opens the existing AgentForm create dialog with `trigger_status` pre-filled; save → diagram re-derives via existing invalidation; identical validation/422/warnings behavior.

**Independent Test**: From a rendered diagram, click "+" on a status node → create dialog opens with that status pre-selected in the trigger select; submit valid config via msw → dialog closes and the graph recomputes with the new agent; cancel → unchanged.

### Tests for User Story 2 (write first — must FAIL before implementation) ⚠️

- [X] T011 [P] [US2] Extend `apps/web/test/agents-diagram-view.spec.ts`: click `data-test="status-add-agent"` on a status node → dialog opens, trigger-status select value equals that status (FR-015, US2-1); msw `POST /api/agents` success → dialog closes and updated agents payload re-renders the diagram with the new node (FR-017, US2-3); cancel leaves diagram unchanged (US2-5); consecutive "+" clicks on two different statuses each re-seed the form (remount-key regression guard)
- [X] T012 [P] [US2] Extend `apps/web/test/agent-form.spec.ts`: `initialTriggerStatus` seeds `form.trigger_status` in create mode; it is IGNORED when `agent` prop is set (edit); omitted → empty default as today (contracts §3)

### Implementation for User Story 2

- [X] T013 [US2] Add optional `initialTriggerStatus?: string` prop to `apps/web/src/components/AgentForm/AgentForm.vue`; seed-only: `trigger_status: a?.trigger_status ?? props.initialTriggerStatus ?? ''` in the `reactive` init; nothing else changes (research R4, contracts §3)
- [X] T014 [US2] Add the "+" affordance to `apps/web/src/components/AgentsDiagram/StatusNode.vue` (every status node — spec assumption): small `el-button` with static lucide `Plus`, `data-test="status-add-agent"`, emitting the node's status name; re-emit as `create-agent` from `apps/web/src/components/AgentsDiagram/AgentsDiagram.vue` (contracts §2/§2a)
- [X] T015 [US2] Wire creation in `apps/web/src/views/AgentsList.vue`: `createTriggerStatus` ref; `@create-agent` → set ref + `openCreate()`; pass `:initial-trigger-status` to `<AgentForm>`; extend the dialog remount key to `` editing?.id ?? `new:${createTriggerStatus ?? ''}` ``; clear the ref on dialog close and on plain "New agent" (contracts §4)
- [X] T016 [US2] Verify: T011 + T012 green; quickstart walk step 7 by hand (including a server-side 422 case)

**Checkpoint**: Diagram-driven creation works end-to-end; list-mode creation regression-free.

---

## Phase 5: User Story 3 - Edit an agent from its node (Priority: P3)

**Goal**: Edit button on each agent node opens the existing edit dialog for that agent, identical to the table's Edit action; saved changes re-derive the graph.

**Independent Test**: Click edit on an agent node → edit dialog opens loaded with that agent; change `status_failure` via msw → failure edge re-targets on the recomputed diagram without reload.

### Tests for User Story 3 (write first — must FAIL before implementation) ⚠️

- [X] T017 [P] [US3] Extend `apps/web/test/agents-diagram-view.spec.ts`: click `data-test="agent-edit"` on an agent node → dialog opens in edit mode for exactly that agent (FR-016, US3-1); msw `PUT` returning the agent disabled → node and its edges disappear, solely-referenced statuses turn muted (US3-3)

### Implementation for User Story 3

- [X] T018 [US3] Add the edit button to `apps/web/src/components/AgentsDiagram/AgentNode.vue`: `el-button` with static lucide `Pencil`, `data-test="agent-edit"`, emitting `data.agent`; re-emit as `edit-agent` from `apps/web/src/components/AgentsDiagram/AgentsDiagram.vue` (contracts §2/§2a)
- [X] T019 [US3] Wire `@edit-agent="openEdit"` on `<AgentsDiagram>` in `apps/web/src/views/AgentsList.vue` (reuses the existing handler and dialog verbatim); verify T017 green and quickstart walk step 8 by hand

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final conventions audit and the full gate

- [X] T020 [P] Theme/motion audit across `apps/web/src/components/AgentsDiagram/*`: dark theme legible (all colors are `--el-color-*` tokens — no hardcoded brand colors anywhere, incl. Vue Flow style overrides); `prefers-reduced-motion` honored; icons static (hover animation remains sidebar-only)
- [X] T021 [P] Append the iteration entry to `docs/progress.md` (feature 018: diagram view mode — what shipped, decisions R1–R7 pointers)
- [X] T022 Run the full gate `pnpm typecheck && pnpm lint && pnpm test` at repo root and the complete quickstart.md manual walk (steps 1–10, incl. reduce-motion, dark theme, and the statuses-502 error state)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: empty — Setup unblocks the stories directly
- **US1 (Phase 3)**: needs T001 (deps) and T002 (test env). **Blocks US2 and US3** (they decorate US1's canvas — declared in the spec).
- **US2 (Phase 4)** and **US3 (Phase 5)**: each needs US1 complete; independent of each other — parallelizable
- **Polish (Phase 6)**: after all desired stories

### Within-story ordering

- Tests first, confirmed failing (T003/T004 → then T005–T009; T011/T012 → T013–T015; T017 → T018–T019)
- T005 (buildGraph) before T008 (canvas) before T009 (view integration); T006/T007 (node SFCs) parallel to each other after T005's types exist
- T013 (form prop), T014 (node affordance) are parallel files; T015 (view wiring) needs both

### Parallel Opportunities

```text
Phase 1:  T001 ∥ T002
US1:      T003 ∥ T004  →  T005  →  T006 ∥ T007  →  T008 → T009 → T010
US2:      T011 ∥ T012  →  T013 ∥ T014  →  T015 → T016
US3:      T017         →  T018 → T019            (US2 ∥ US3 after US1)
Polish:   T020 ∥ T021  →  T022
```

## Implementation Strategy

**MVP first**: Phase 1 → Phase 3 (US1) → validate (T010) → the read-only diagram is already demoable. Then US2 (the highest-value interaction), then US3, then Polish. Single-developer flow is simply T001→T022 in ID order; the [P] markers show where an agent/pair can fan out. Each checkpoint leaves the branch shippable — `AgentsList.vue` keeps the table path untouched, so an abort after any phase degrades to today's behavior plus whatever landed.

## Notes

- The whole-list agents query key MUST be byte-identical to AgentForm's (`{ page: 1, page_size: MAX_PAGE_SIZE }`) — that identity is the consistency mechanism (research R2); a deviating key silently breaks FR-003/SC-005.
- `<VueFlow>` stays stubbed in interaction tests; graph semantics are asserted only through `buildGraph` (research R3). Don't add assertions on rendered SVG paths.
- `status_running` is intentionally not an edge (research R5) — do not "fix".

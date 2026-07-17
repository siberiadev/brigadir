# Implementation Plan: Agents Diagram View Mode

**Branch**: `claude/agents-diagram-view-mode-832dbb` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/018-agents-diagram-view/spec.md`

## Summary

Add a List/Diagram toggle to the workspace Agents page (`/workspaces/:id/agents`). Diagram mode renders the emergent pipeline as an interactive directed graph: status nodes (live board statuses) and agent nodes (visible worker agents), connected by trigger edges (status → agent) and success/failure outcome edges (agent → status). The graph is pure derived client state — a computed over the two existing TanStack queries (`useAgents` whole-list page, `useStatuses`) — rendered with Vue Flow and laid out left-to-right by dagre. Status nodes carry a "+" that opens the existing `AgentForm` create dialog with `trigger_status` pre-filled (one new optional prop on the form); agent nodes carry an edit button opening the existing edit dialog. Nothing is persisted: no new endpoints, no schema changes, no stored positions, no stored view mode.

## Technical Context

**Language/Version**: TypeScript 5.7 (`strict: true`), Vue 3.5 SFC (`<script setup>`)

**Primary Dependencies**: Existing — Element Plus 2.9, @tanstack/vue-query 5, lucide-vue-next, vue-router 4, sass. **New (client-only)** — `@vue-flow/core` ^1.x (graph canvas), `@dagrejs/dagre` ^1.x (layered LR layout). Both decided by the feature description.

**Storage**: None. The diagram is derived state over two already-cached queries; view mode is a local `ref` that dies with the component.

**Testing**: Vitest 2 (jsdom) + @vue/test-utils + msw 2, in `apps/web/test/` (existing harness, `test/setup.ts` msw lifecycle with `onUnhandledRequest: 'error'`)

**Target Platform**: Desktop browsers, internal dashboard (light + dark theme)

**Project Type**: Web frontend only — `apps/web` in the pnpm monorepo; zero backend surface

**Performance Goals**: Diagram visible <1 s after toggle with warm data (SC-002); layout is synchronous dagre over ≤35 nodes — no perceptible cost

**Constraints**: No backend/schema/API changes; no persistence of mode or positions; brand colors only via `var(--el-color-*)` (`_theme.scss` is the only override home); lucide icons, static (hover animation is sidebar-only); `prefers-reduced-motion` respected; whole-list consumers fetch `page_size=100` (MAX_PAGE_SIZE), never paginate

**Scale/Scope**: ≤20 agent nodes (roster cap) + ~10–15 status nodes, ≤61 edges (≤3 per agent + 1 trigger); one view file touched, one new component directory, one form prop

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Dual Source of Truth | ✅ PASS | The diagram *visualizes* the emergent pipeline exactly as Principle I defines it (agent trigger bindings over board statuses) and introduces no third source of truth: no stored diagram JSON, no cached graph — every render derives from the live agents + statuses queries. Stale-status "missing" nodes make Jira-vs-config drift visible instead of hiding it. |
| II. Idempotency at Three Levels | ✅ N/A | No run-triggering path is touched. Creates/edits go through the existing dialog → existing endpoints. |
| III. System-Only Jira Writes | ✅ N/A | Frontend-only; no Jira interaction of any kind. |
| IV. Run Completion Contract | ✅ N/A | Runs are untouched. |
| V. Secret Isolation | ✅ N/A | No secrets, no env, no executor surface. |
| VI. Test-Mandatory Pipeline Logic | ✅ PASS | No pipeline logic changes (the UI exemption applies), but the spec self-imposes coverage anyway (SC-006): graph derivation is a pure function with unit tests; interactions get component tests — shipped in the same iteration per «Выстраданное правило» 4. |
| Tech Constraints (stack fixed) | ✅ PASS | Vue dashboard extended, TS strict everywhere. Two new *client-side rendering* deps (Vue Flow, dagre) do not alter the fixed backend stack and were decided in the feature description. Lazy-resource-resolution rule is backend DI-specific — N/A. |
| Development Workflow | ✅ PASS | One-PR-sized iteration; tests in the same change; no cut-scope features reintroduced. |

**Post-design re-check (after Phase 1)**: unchanged — the design added no persistence, no endpoints, and no pipeline surface. Gate holds.

## Project Structure

### Documentation (this feature)

```text
specs/018-agents-diagram-view/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (client view-model)
├── quickstart.md        # Phase 1 output (validation guide)
├── contracts/
│   └── components.md    # Phase 1 output (component/props/emits contracts)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/web/
├── package.json                          # MODIFIED: + @vue-flow/core, + @dagrejs/dagre
├── src/
│   ├── views/
│   │   └── AgentsList.vue                # MODIFIED: List/Diagram toggle; hosts BOTH modes and
│   │                                     #   the single shared FormDialog/AgentForm instance
│   ├── components/
│   │   ├── AgentsDiagram/                # NEW component directory
│   │   │   ├── buildGraph.ts             #   pure derivation: (agents, statuses) → GraphModel
│   │   │   ├── AgentsDiagram.vue         #   Vue Flow canvas + dagre layout + empty/error states
│   │   │   ├── AgentNode.vue             #   custom node: name/role, edit button, JQL badge
│   │   │   └── StatusNode.vue            #   custom node: name, normal/muted/missing, "+" affordance
│   │   └── AgentForm/
│   │       └── AgentForm.vue             # MODIFIED: optional `initialTriggerStatus` prop (create only)
│   └── composables/                      # UNCHANGED — useAgents/useStatuses reused as-is
└── test/
    ├── agents-diagram-graph.spec.ts      # NEW: buildGraph unit tests (visibility/edges/cycles)
    └── agents-diagram-view.spec.ts       # NEW: toggle + "+"/edit interaction tests
```

**Structure Decision**: Everything lives in `apps/web` (the Vue dashboard). `AgentsList.vue` stays the single owner of the create/edit dialog so both modes share one `AgentForm` mount, one saved-handler, and the existing query invalidation — the diagram only *emits* intents (`create-agent(statusName)`, `edit-agent(agent)`). Graph derivation is isolated in `buildGraph.ts` as a pure function so the spec's semantics tests run without mounting a canvas. No backend, contracts-package, or worker files are touched.

## Complexity Tracking

No constitution violations — table intentionally empty.

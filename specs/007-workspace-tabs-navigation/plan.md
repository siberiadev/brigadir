# Implementation Plan: Workspace Tabs Navigation

**Branch**: `007-workspace-tabs-navigation` (dev branch `claude/workspace-tabs-navigation-c6fhio`) | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-workspace-tabs-navigation/spec.md`

## Summary

Rework the workspace-level navigation in the dashboard (`apps/web`) so a workspace is a
**page with two router-driven tabs — Agents | Runs** — instead of two separate per-row
buttons. Clicking a workspace **row** in `WorkspaceList` opens that workspace's page (Agents
tab by default); a shared `WorkspaceTabs` component switches the list below by pushing a
route, so the URL is the single source of truth for the active tab.

The two shipped deep-link paths `/workspaces/:id/agents` and `/workspaces/:id/runs` are
**kept verbatim** and become nested children of one `WorkspacePage` route component. Because
they are the same routes as before, every existing link (`WorkspaceList.onCreated`, and any
run-card / human-queue / navbar link that targets them) keeps resolving with **zero consumer
changes** (FR-009), and browser back/forward across tabs falls out of normal router history
(FR-010). `AgentsList.vue` and `Runs.vue` are reused **as-is** as the two tab bodies —
no behavior change inside the lists (FR-011).

**Frontend-only** (FR-014): no `packages/contracts`, backend, worker, or schema changes; the
006 polling composables (`useRuns`, `useHumanTasks`, …) are untouched. Coverage is msw
component tests extending `apps/web/test/{mount,handlers}.ts` for tab switching, row-click
navigation, deep-link resolution of **both** shipped paths, unknown-tab fallback to Agents,
and that Settings/Pause clicks do not navigate.

## Technical Context

**Language/Version**: TypeScript strict (Node ≥22); Vue 3 SFCs (`<script setup lang="ts">`).

**Primary Dependencies**: Vue 3.5, Vue Router 4.5 (nested routes + named-route redirects),
Element Plus 2.9 (`el-tabs`/`el-tab-pane`, `el-table` `@row-click`), Pinia,
`@tanstack/vue-query` 5 (cache makes tab-swap remounts cheap). No new dependency.

**Storage**: N/A — no persistence, no API, no contract touched.

**Testing**: Vitest 2 + `@vue/test-utils` 2 + msw 2 (`jsdom`), run via `pnpm --filter
@brigadir/web test` (`vitest run`). Router assertions use a real `createMemoryHistory` router
built from the app's routes; the API boundary stays faked by the existing 006 msw handlers.

**Target Platform**: Browser SPA (the existing dashboard behind App.vue's token gate).

**Project Type**: Web frontend within the pnpm monorepo (`apps/web`).

**Performance Goals**: Tab switch swaps only the nested `<router-view>` (parent page and app
shell stay mounted); no full page reload and no refetch of unrelated data (cached queries
resolve instantly).

**Constraints**: Follow existing Element Plus + component-folder + scoped-SCSS conventions
(FR-015). URL is the single source of truth for the active tab — the tabs component drives
router navigation, never local `ref` state.

**Scale/Scope**: 2 new files (`WorkspacePage.vue`, `WorkspaceTabs/WorkspaceTabs.vue`), 2
edited source files (`router/index.ts`, `WorkspaceList.vue`), 1 edited test helper
(`test/mount.ts`), 1 new test file. ~2 tabs, 5 routes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|-----------|----------|------------|
| I. Dual Source of Truth | No | No run/ticket state is written or cached; pure client navigation over existing read projections. |
| II. Idempotency at Three Levels | No | No run-triggering path touched. |
| III. System-Only Jira Writes | No | No Jira write; no agent path touched. |
| IV. Run Completion Contract | No | No run lifecycle or callback code touched. |
| V. Secret Isolation & Output Scrubbing | No | No secrets, tokens, or argv; App.vue token gate and bearer flow unchanged (no token ever placed in a URL — deep-link routes carry only workspace id + tab). |
| VI. Test-Mandatory Pipeline Logic | Yes (exemption) | UI-only change — the explicit "UI and cosmetic changes MAY ship with lighter coverage" exemption applies. Still shipping msw component tests for every acceptance scenario. No pipeline logic in this feature. |
| Tech Constraints (TS strict, Vue.js dashboard, lazy resource resolution) | Yes | Vue.js is the mandated dashboard stack; `strict: true` preserved (no `any` at new module boundaries — the sole `as any` remains the pre-existing shared test-harness cast). No DI/module composition, so lazy-resolution rule is N/A. |

**Result**: PASS. No violations; Complexity Tracking not required.

**Post-design re-check (after Phase 1)**: Still PASS. The design adds only client views, a
shared component, and router config; it introduces no persistence, no API/contract, no Jira
write, no DI/module composition, and no `any` at new boundaries. UI-exemption under Principle
VI holds and tests still ship for every acceptance scenario.

## Project Structure

### Documentation (this feature)

```text
specs/007-workspace-tabs-navigation/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output — R1..R5 decisions
├── data-model.md        # Phase 1 output — view-model entities (no DB)
├── quickstart.md        # Phase 1 output — manual + test validation
├── contracts/
│   └── ui-routes.md      # Phase 1 output — route table, component props, data-test selectors
├── checklists/
│   └── requirements.md   # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/web/
├── src/
│   ├── router/
│   │   └── index.ts                 # EDIT: nest agents|runs under /workspaces/:id → WorkspacePage;
│   │                                #       empty + unknown-tab redirects → Agents; settings stays top-level
│   ├── views/
│   │   ├── WorkspacePage.vue         # NEW: parent tab page — <WorkspaceTabs> + <router-view/>
│   │   ├── WorkspaceList.vue         # EDIT: drop Agents/Runs buttons; @row-click nav; @click.stop on actions
│   │   ├── AgentsList.vue            # REUSED AS-IS (Agents tab body) — no change (FR-011)
│   │   └── Runs.vue                  # REUSED AS-IS (Runs tab body) — no change (FR-011)
│   └── components/
│       └── WorkspaceTabs/
│           └── WorkspaceTabs.vue     # NEW: shared, router-driven tab strip (el-tabs); reusable (FR-013)
└── test/
    ├── mount.ts                      # EDIT: allow a real routes[] + initialPath for navigation tests
    ├── handlers.ts                   # REUSED (agents/runs endpoints already faked); extend only if a 2nd row is needed
    └── workspace-tabs.spec.ts        # NEW: tab switch, row-click nav, deep-link (both paths), unknown-tab fallback, action no-nav
```

**Structure Decision**: Single frontend package (`apps/web`), existing Vue 3 + Vue Router +
Element Plus layout. The feature adds one view (`WorkspacePage`) and one component folder
(`WorkspaceTabs/`, mirroring the existing `AgentForm/` / `ExecutorForm/` / `WorkspaceForm/`
convention) and edits the router and the workspace list. No backend/worker/contracts paths
are in scope.

## Complexity Tracking

> Not required — Constitution Check passed with no violations.

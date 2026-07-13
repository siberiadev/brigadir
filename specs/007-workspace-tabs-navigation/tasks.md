---
description: "Task list for Workspace Tabs Navigation"
---

# Tasks: Workspace Tabs Navigation

**Input**: Design documents from `/specs/007-workspace-tabs-navigation/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ui-routes.md ✓, quickstart.md ✓

**Tests**: This is a UI-only feature (constitution Principle VI UI-exemption applies — no pipeline logic). Tests are nonetheless shipped for **every** acceptance scenario per the plan and the user's constraint. Within each group, tests are written **first** (they must fail before the source change lands).

**Organization**: Tasks are grouped by user story. Because the feature is small and frontend-only, it is executed as a **single implement session** — no session split. The build order threads a single logical sequence through the stories: shared test-harness → `WorkspaceTabs` → `WorkspacePage` + router (US1/US2) → `WorkspaceList` cleanup (US3) → full component-test suite → docs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- All paths are repository-relative; the feature is confined to `apps/web/`.

## Path Conventions

- Frontend package: `apps/web/src/` (source), `apps/web/test/` (component tests).
- No `packages/contracts`, backend, worker, or schema paths are in scope (FR-014, SC-006).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend the shared test harness so navigation/deep-link tests can drive a real router. Backward-compatible — existing specs pass no `routes` and keep today's catch-all stub.

- [ ] T001 Read `apps/web/test/mount.ts`, `apps/web/test/handlers.ts`, and an existing consumer (`apps/web/test/workspace-list.spec.ts`) to confirm the current `mountWithProviders` signature and the 006 msw handlers (`/api/agents?workspace=`, `/api/workspaces/:id/runs`, `/api/workspaces/:id/runs/cost`, `/api/workspaces`) before editing.
- [ ] T002 Extend `MountOptions` and `mountWithProviders` in `apps/web/test/mount.ts` to accept optional `routes?: RouteRecordRaw[]` and `initialPath?: string`: when `routes` is provided, build the memory-history router from them, `await router.push(initialPath ?? '/')` and `await router.isReady()` before `mount`; when absent, keep the existing single catch-all stub route unchanged (backward compatible). Keep the sole pre-existing `as any` cast; add no new `any` at the boundary (TS strict).

**Checkpoint**: `pnpm --filter @brigadir/web test` still green (no existing spec passes `routes`, so all keep the stub path); `pnpm --filter @brigadir/web typecheck` green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None beyond Setup. This feature has no cross-story foundational layer — `WorkspaceTabs` (built in US1) is the only shared source artifact and belongs to the story that first needs it. No separate foundational tasks.

*(intentionally empty — proceed to user stories)*

---

## Phase 3: User Story 1 — Open a workspace and switch between Agents and Runs (Priority: P1) 🎯 MVP

**Goal**: A workspace becomes a page with two router-driven tabs (Agents | Runs). Clicking a workspace row opens it on Agents; the shared `WorkspaceTabs` swaps the nested list by pushing a route, so the URL is the single source of truth for the active tab (no full page reload).

**Independent Test**: Mount the real router at `/workspaces/ws-1/agents`; assert `agents-table` renders under a `workspace-tabs` strip; click `workspace-tab-runs` → `runs-table`/`runs-empty` renders, `agents-table` gone, route name is `runs`; click `workspace-tab-agents` → agents body returns. Mount `WorkspaceList` with the real router and click a row → route becomes `/workspaces/<id>/agents`.

### Tests for User Story 1 (write first — must FAIL before T007–T009) ⚠️

- [ ] T003 [US1] Create `apps/web/test/workspace-tabs.spec.ts` with the tab-switch scenarios (US1 #2/#3, FR-007/FR-008): mount `WorkspacePage` (or the router tree) via `mountWithProviders` with the app's real workspace `routes` at `initialPath` `/workspaces/ws-1/agents`; assert `agents-table` present and `workspace-tabs` rendered; click `workspace-tab-runs`, `flush()`, assert `runs-table`/`runs-empty` present, `agents-table` absent, `router.currentRoute.value.name === 'runs'` and path is `/workspaces/ws-1/runs`; click `workspace-tab-agents`, assert `agents-table` returns and route name is `agents`. Confirm this FAILS (no `WorkspacePage`/`WorkspaceTabs` yet).
- [ ] T004 [US1] Add the row-click navigation test (US1 #1, FR-003) to `apps/web/test/workspace-tabs.spec.ts` (or `workspace-list.spec.ts`): mount `WorkspaceList` with the real `routes`, `trigger('click')` a `.el-table__row` under `workspaces-table`, assert route becomes `/workspaces/<id>/agents`. Confirm it FAILS (list has no `@row-click` yet).

### Implementation for User Story 1

- [ ] T005 [US1] Create `apps/web/src/components/WorkspaceTabs/WorkspaceTabs.vue` — a shared, reusable, router-driven tab strip (FR-013): `defineProps<{ id: string; tabs: { name: string; label: string }[] }>()`; active tab = `computed` from `useRoute().name` (no mutable ref, URL is source of truth per FR-008); wrap Element Plus `el-tabs` with label-only `el-tab-pane`s; `@tab-change` → `router.push({ name, params: { id } })`. Root carries `data-test="workspace-tabs"`; each label carries `data-test="workspace-tab-<name>"` (i.e. `workspace-tab-agents` / `workspace-tab-runs`). Scoped SCSS, matching house style (FR-015).
- [ ] T006 [US1] Create `apps/web/src/views/WorkspacePage.vue` — parent tab page: `defineProps<{ id: string }>()` (`props: true`); renders `<WorkspaceTabs :id="id" :tabs="[{ name: 'agents', label: 'Agents' }, { name: 'runs', label: 'Runs' }]" />` then `<router-view />`. No duplicate workspace-name heading (the list bodies already render one — FR-011).
- [ ] T007 [US1] Nest the tabs under a parent route in `apps/web/src/router/index.ts`: convert `/workspaces/:id` into a parent record whose component is `WorkspacePage` (`props: true`), with children `''` (name `workspace`) → redirect to `{ name: 'agents', params: { id } }` (default tab, FR-006), `agents` (name `agents`) → `AgentsList` (`props: true`), `runs` (name `runs`) → `Runs` (`props: true`). Keep the child paths so the shipped strings `/workspaces/:id/agents` and `/workspaces/:id/runs` resolve **verbatim** (FR-009). Do not touch `/workspaces/:id/settings`, `/runs/:id`, `/`, or `/human-queue`.
- [ ] T008 [US1] Add row-click navigation to `apps/web/src/views/WorkspaceList.vue`: add `@row-click` on the `workspaces-table` `el-table` → `router.push({ name: 'agents', params: { id: row.id } })`; add `cursor: pointer` on table rows (mirror `Runs.vue`) to signal clickability. (Button removal + `@click.stop` handled in US3 — T013.)
- [ ] T009 [US1] Run `pnpm --filter @brigadir/web test` and confirm T003 + T004 now PASS; run `pnpm --filter @brigadir/web typecheck`.

**Checkpoint**: Row click opens the workspace page on Agents; the tab strip swaps Agents⇄Runs by route push with no full reload; URL reflects the active tab. US1 independently testable.

---

## Phase 4: User Story 2 — Deep-links to a workspace's agents or runs keep working (Priority: P1)

**Goal**: Both shipped deep-link paths resolve to the workspace page with the matching tab active; an unknown tab falls back to Agents; `/settings` still resolves ahead of the fallback; browser back returns to the prior tab.

**Independent Test**: Push `/workspaces/ws-1/runs` → Runs body renders, active tab Runs; push `/workspaces/ws-1/agents` → Agents body, active tab Agents; push `/workspaces/ws-1/bogus` → lands on Agents; `router.resolve('/workspaces/ws-1/settings').name === 'workspace-settings'`.

### Tests for User Story 2 (write first — must FAIL before T012) ⚠️

- [ ] T010 [US2] Add deep-link resolution tests to `apps/web/test/workspace-tabs.spec.ts` (US2 #1/#2, FR-009 — **both** paths): mount at `initialPath` `/workspaces/ws-1/runs`, assert `runs-table`/`runs-empty` renders and route name `runs`; mount at `/workspaces/ws-1/agents`, assert `agents-table` renders and route name `agents`. Add the back-navigation test (US2 #3, FR-010): from agents, click `workspace-tab-runs`, `await router.back()`, assert route name is `agents` again.
- [ ] T011 [US2] Add the unknown-tab fallback test and the settings-precedence guard to `apps/web/test/workspace-tabs.spec.ts`: push/resolve `/workspaces/ws-1/bogus` and assert it lands on `agents` (FR-012); assert `router.resolve('/workspaces/ws-1/settings').name === 'workspace-settings'` (the static `settings` route must out-rank the nested `:catchAll` redirect). Confirm these FAIL before T012.

### Implementation for User Story 2

- [ ] T012 [US2] Add the unknown-tab fallback child to the parent route in `apps/web/src/router/index.ts`: a `:catchAll(.*)*` child → redirect to `{ name: 'agents', params: { id } }` (FR-012). Verify by test (T011) that the top-level static `/workspaces/:id/settings` record still resolves to `workspace-settings` and is not swallowed by the nested wildcard.
- [ ] T013 [US2] Run `pnpm --filter @brigadir/web test` and confirm T010 + T011 PASS; `pnpm --filter @brigadir/web typecheck`.

**Checkpoint**: Both shipped deep-links resolve to the right tab; unknown tab → Agents; `/settings` precedence held; back/forward moves between tabs. US2 independently testable.

---

## Phase 5: User Story 3 — Workspace list stays focused on lifecycle actions (Priority: P2)

**Goal**: Remove the per-row Agents and Runs buttons; keep Settings and Start/Pause with unchanged behavior; ensure activating a row action does **not** also navigate into the workspace.

**Independent Test**: Render `WorkspaceList` — no Agents/Runs buttons on any row; Settings still opens the settings dialog; clicking `toggle-pause-<id>` toggles pause and does **not** change the route to the workspace page.

### Tests for User Story 3 (write first — must FAIL before T015) ⚠️

- [ ] T014 [US3] Add the button-removal and action-no-navigation tests to `apps/web/test/workspace-tabs.spec.ts` (or `workspace-list.spec.ts`): assert no Agents/Runs button text or `RouterLink`s render in `workspaces-table` rows (FR-001); with the real router mounted, click `toggle-pause-<id>` and assert the route did **not** navigate to `/workspaces/<id>/agents` (FR-004); click Settings and assert it opens the settings dialog without navigating. Confirm the FR-004 assertion FAILS before `@click.stop` is added (T015).

### Implementation for User Story 3

- [ ] T015 [US3] Edit `apps/web/src/views/WorkspaceList.vue`: remove the two `RouterLink` Agents and Runs `el-button`s from the actions column (FR-001, and drop the now-unused `RouterLink` import if it becomes unused); add `@click.stop` to the Settings button and to the Start/Pause button so their native click does not bubble to the table `@row-click` (FR-004). Leave `openSettings`/`togglePause` behavior otherwise unchanged (FR-002).
- [ ] T016 [US3] Run `pnpm --filter @brigadir/web test` and confirm T014 PASS; `pnpm --filter @brigadir/web typecheck`.

**Checkpoint**: List rows show only Settings and Start/Pause; row actions never navigate; row-body click still opens the workspace. All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Full-suite verification and the iteration journal entry.

- [ ] T017 Run the complete gate from the repo root / web package: `pnpm --filter @brigadir/web typecheck && pnpm --filter @brigadir/web lint && pnpm --filter @brigadir/web test`. Confirm all existing specs stay green (SC-005), TS strict passes, and the new `workspace-tabs.spec.ts` scenarios all pass. Manually confirm SC-006: `git diff --name-only` shows changes confined to `apps/web/` and `specs/007-.../` — no `packages/contracts`, backend, worker, or `drizzle/` files.
- [ ] T018 Append an iteration-7 entry to `docs/progress.md` recording the workspace-tabs navigation change: nested `agents`/`runs` under `WorkspacePage`, shared `WorkspaceTabs` component, row-click navigation with `@click.stop` on row actions, unknown-tab→Agents fallback, settings-route precedence, and the `test/mount.ts` `routes`/`initialPath` extension — per CLAUDE.md ("новые итерации дописываются туда").

---

## Dependencies & Execution Order

### Phase / Story Dependencies

- **Setup (Phase 1, T001–T002)**: no dependencies — start immediately. Blocks all navigation tests (they need the extended harness).
- **US1 (Phase 3)**: depends on Setup. Delivers `WorkspaceTabs`, `WorkspacePage`, the parent-route nesting, and row-click nav — the MVP.
- **US2 (Phase 4)**: depends on US1's parent route existing (T007). Adds the `:catchAll` fallback child and its tests; deep-link resolution of `agents`/`runs` already works from US1.
- **US3 (Phase 5)**: depends on US1's `@row-click` (T008) for the FR-004 no-navigation assertion; the button removal itself is independent. Runs after US1.
- **Polish (Phase 6)**: depends on all stories complete.

### Within Each Story

- Tests are authored **first** and must fail before the corresponding source task (T003/T004 → T005–T008; T010/T011 → T012; T014 → T015).
- `WorkspaceTabs` (T005) before `WorkspacePage` (T006) before the router nesting (T007) — the page consumes the component, the route mounts the page.

### Parallel Opportunities

- Small feature, mostly one file per step, so parallelism is limited. `WorkspaceTabs.vue` (T005) and the `WorkspaceList` `@row-click` edit (T008) touch different files and could be authored in parallel once their tests exist, but T007 (router) depends on T006 which depends on T005 — keep the source chain sequential.
- All test-authoring tasks that only add cases to `workspace-tabs.spec.ts` must be serialized (same file): T003 → T004 → T010 → T011 → T014.

---

## Implementation Strategy

### Single session (per user constraint)

Execute Phases 1→6 in one implement session, tests-first within each group. There is no session split.

### MVP scope

**User Story 1 (Phase 3)** is the MVP: row-click into a workspace page with working Agents⇄Runs tabs and URL-reflected active tab. Stopping after US1 already delivers the core value; US2 (deep-link hardening) and US3 (list cleanup) are increments on top.

### Suggested checkpoints

1. After T002 — harness extended, existing suite still green.
2. After T009 — US1/MVP working and tested.
3. After T013 — deep-links + fallback + settings-precedence proven.
4. After T016 — list cleanup done, actions don't navigate.
5. After T018 — full gate green, progress logged.

---

## Notes

- **Constitution**: UI-only (Principle VI UI-exemption); tests still ship for every acceptance scenario. No pipeline logic, no Jira write, no DI/module-composition, no `any` at new boundaries (Tech Constraints).
- **Backward compatibility**: `mount.ts` change is additive; the ~12 existing specs pass no `routes` and keep the stub router unchanged.
- **Reused as-is (FR-011)**: `AgentsList.vue` and `Runs.vue` are NOT edited — they are the two tab bodies. No handler changes to `handlers.ts` unless a scenario needs a second workspace/agent row.
- **Verify at implementation (research R1 risk)**: the nested `:catchAll` redirect must not swallow the top-level `/workspaces/:id/settings`; T011 asserts this so a future route reorder can't silently regress it.
- Commit after each logical group; verify tests fail before implementing each source task.

---
description: "Task list for feature 009 — Icon Sidebar Navigation"
---

# Tasks: Icon Sidebar Navigation

**Input**: Design documents from `/specs/009-icon-sidebar-nav/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/app-sidebar.md, quickstart.md

**Tests**: FR-016 mandates component tests for this UI feature, so test tasks ARE
included (constitution VI treats this as the lighter-coverage UI class, but the
spec requires the msw component suite). Tests-first WITHIN each group: write the
assertions against the `data-test` contract, then implement until green.

**Organization**: Grouped by user story. This is a small frontend-only change
confined to `apps/web` and centered on two files (`AppSidebar.vue`, `App.vue`)
plus one new spec (`test/app-sidebar.spec.ts`) — see plan.md "Project Structure".
It is intended for a SINGLE implement session in the order below:
dependency → `AppSidebar.vue` (presentational) → `App.vue` shell rework →
remove old header nav → component tests → progress entry.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 (maps to spec.md user stories); Setup/Foundational/Polish carry no story label
- Every task names an exact file path under `apps/web/`

## Path Conventions

Web frontend workspace `@brigadir/web` at `apps/web/`:

- Component: `apps/web/src/components/AppSidebar.vue`
- Shell: `apps/web/src/App.vue`
- Reused: `apps/web/src/composables/useHumanTasks.ts`, `apps/web/src/router/index.ts`, `apps/web/src/stores/auth.ts`
- Test: `apps/web/test/app-sidebar.spec.ts` (harness `apps/web/test/mount.ts`)
- Docs: `docs/progress.md`

> Nearly every task touches one of the two central files, so genuine parallelism is
> limited — the `[P]` markers are honest (see "Parallel Opportunities"). Follow the
> phase order top to bottom.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Land the one new frontend dependency the whole feature needs.

- [X] T001 Add `lucide-vue-next` to `apps/web/package.json` dependencies and install it (`pnpm --filter @brigadir/web add lucide-vue-next` from repo root, then `pnpm install`); confirm the lockfile updates and `import { LayoutGrid, Inbox, LogOut } from 'lucide-vue-next'` resolves under strict TS (research R1)

**Checkpoint**: Dependency available — the sidebar component can import lucide glyphs.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Stand up the test harness, the presentational component skeleton, and
the `App.vue` shell that renders the sidebar. **Every user story below builds on
these three tasks.** No story behavior can be asserted until the shell renders the
sidebar and the spec file can mount the real routes.

**⚠️ CRITICAL**: Complete this phase before starting any user story phase.

- [X] T002 [P] Scaffold `apps/web/test/app-sidebar.spec.ts`: import `{ routes }` from `../src/router`, static-import the lazy view modules to warm the module cache (`WorkspacePage.vue`, `AgentsList.vue`, `Runs.vue`, `WorkspaceSettings.vue`, `WorkspaceList.vue` — the `workspace-tabs.spec.ts` pattern), and add `mountApp(initialPath)` + `settle(predicate)` helpers using `mountWithProviders(AppRoot, { routes, initialPath })` where `AppRoot` mounts `App.vue`; leave `describe` blocks empty for the per-story tests
- [X] T003 Create `apps/web/src/components/AppSidebar.vue` skeleton as a PURE presentational component: declare `defineProps<{ openCount: number }>()` and `defineEmits<{ (e: 'sign-out'): void }>()`, named lucide imports (`LayoutGrid`, `Inbox`, `LogOut`), the static two-item `NavItem` array from data-model.md (`workspaces` → `LayoutGrid`/`'/'`, `human-queue` → `Inbox`/`'/human-queue'`), and the root `<aside data-test="app-sidebar">` with empty brand / nav / bottom-pinned sign-out regions — no `App.vue` coupling, no count query inside (contracts/app-sidebar.md Props/Events)
- [X] T004 Rework `apps/web/src/App.vue` shell: KEEP the `v-if="!auth.token"` branch a full-screen token gate WITHOUT any sidebar; in the authenticated `v-else` branch render `<AppSidebar :open-count="openCount" @sign-out="auth.clear()" />` as a `position: fixed` left rail ~70px wide × full viewport height plus a main region offset by `margin-left` equal to the rail width (nothing under the rail); KEEP `authed`, `countQuery` (`useHumanTaskCount`), `openCount`, and the 006 landing `watch` in `App.vue` unchanged; REMOVE the old `el-header` / `.app-nav` / inline `el-badge` / inline Sign out button (FR-001/002/011/013/014, research R5)

**Checkpoint**: Authenticated shell renders `AppSidebar` beside offset content; the
gate stays sidebar-free; the spec file can mount the app at any real route.

---

## Phase 3: User Story 1 - Navigate the app from an icon sidebar (Priority: P1) 🎯 MVP

**Goal**: The icon-only navigation rail itself — brand mark + Workspaces + Human
queue icons with right-placed tooltips that route on click; content offset, no top
header.

**Independent Test**: Mount the authed shell; assert `app-sidebar` renders with
`sidebar-brand`, `nav-workspaces`, `nav-human-queue`, `sidebar-sign-out`; assert each
nav/sign-out icon carries a right-placed `el-tooltip` with the exact name; assert no
top nav header exists.

### Tests for User Story 1

> Write these FIRST against the `data-test` contract; they fail until T006 lands.

- [X] T005 [US1] Add the "rendering + tooltips" describe block to `apps/web/test/app-sidebar.spec.ts`: mounting the authed shell shows `app-sidebar` containing `sidebar-brand`, `nav-workspaces`, `nav-human-queue`, and `sidebar-sign-out`; NO top nav header (the old `.app-nav` is gone); each of the three icons is wrapped in an `el-tooltip` with `placement="right"` whose content is exactly "Workspaces" / "Human queue" / "Sign out" (assert on the rendered tooltip content/aria surface, no real hover) (contracts §Tooltip, SC-001/007)

### Implementation for User Story 1

- [X] T006 [US1] Fill `apps/web/src/components/AppSidebar.vue` nav render: `sidebar-brand` compact "B" mark at top; `nav-workspaces` and `nav-human-queue` as `RouterLink` (`to` from the `NavItem` array) each wrapping its lucide icon inside an `el-tooltip placement="right"` with the item `label`; the bottom-pinned `sidebar-sign-out` `LogOut` icon inside an `el-tooltip placement="right"` content "Sign out" (click behavior deferred to US3); icons only, no visible text labels (FR-003/004/005, research R2)

**Checkpoint**: The sidebar renders and routes; hover tooltips name each icon. MVP
navigation surface is functional and independently testable.

---

## Phase 4: User Story 2 - See which section I'm in and how many tasks await (Priority: P1)

**Goal**: Active-section highlight derived from the route, plus the open-task badge
moved onto the Human queue icon (hidden at zero, capped at 99+, updates on poll).

**Independent Test**: Mount at each route and assert the correct item is highlighted;
drive `openCount` > 0 → badge shows the value; `openCount` large → "99+"; `openCount`
0 → no badge; change the prop → badge updates.

### Tests for User Story 2

> Write these FIRST; they fail until T009/T010 land.

- [X] T007 [US2] Add the "active highlight" describe block to `apps/web/test/app-sidebar.spec.ts`: mount at `/`, `/workspaces/ws-1/agents`, and `/workspaces/ws-1/settings` → `nav-workspaces` marked active and `nav-human-queue` not; at `/human-queue` → the reverse; at `/runs/r-1` (no-match run card) → NEITHER active; assert on the component's chosen active marker (`is-active` class or `data-active="true"`), consistent across both items (FR-006/007, SC-002, edge cases "deep sub-routes" + "no matching section")
- [X] T008 [US2] Add the "badge" describe block to `apps/web/test/app-sidebar.spec.ts`: with `openCount` > 0 (via mocked count endpoint or seeded query) `queue-badge` shows the value; a large value renders the "99+" cap; `openCount === 0` (and pre-first-poll → 0) renders NO visible badge; updating the mocked/seeded value updates the badge (FR-008/009/010, SC-003, US2 scenario 5, edge cases ">99" + "not yet loaded")

### Implementation for User Story 2

- [X] T009 [US2] Implement active state in `apps/web/src/components/AppSidebar.vue` from `useRoute().path`: Workspaces active when `path === '/' || path.startsWith('/workspaces')`; Human queue active when `path === '/human-queue'`; any other path highlights nothing; apply the marker (`is-active` class / `data-active`) consistently on both `nav-workspaces` and `nav-human-queue` (FR-006/007, research R3, data-model `isActive`)
- [X] T010 [US2] Add the badge to `nav-human-queue` in `apps/web/src/components/AppSidebar.vue`: `el-badge` with `data-test="queue-badge"`, `:value="openCount"`, `:max="99"`, `:hidden="openCount === 0"`, `type="danger"` wrapping the Human queue icon — the same cap/hidden behavior migrated off the header link; Workspaces carries no badge (FR-008/009/010, research R4, data-model `OpenTaskBadge`)

**Checkpoint**: Orientation (active highlight) and the live open-count badge both work
on the sidebar; US1 + US2 together form a faithful replacement of the header nav.

---

## Phase 5: User Story 3 - Sign out from the sidebar (Priority: P2)

**Goal**: The bottom-pinned Sign out icon clears the session and returns to the
sidebar-free gate.

**Independent Test**: Mount the authed shell, activate `sidebar-sign-out`, assert the
token is cleared, the gate is shown, and `app-sidebar` is no longer rendered.

### Tests for User Story 3

> Write this FIRST; it fails until T012 wires the emit.

- [X] T011 [US3] Add the "sign out" describe block to `apps/web/test/app-sidebar.spec.ts`: activating `sidebar-sign-out` (trigger `click`, jsdom-safe) clears the auth token, renders the full-screen token gate, and leaves `app-sidebar` absent from the tree; also assert the `sidebar-sign-out` tooltip reads "Sign out" (FR-012, SC-005, US3 scenarios 1–3)

### Implementation for User Story 3

- [X] T012 [US3] Wire sign-out in `apps/web/src/components/AppSidebar.vue`: the bottom-pinned `sidebar-sign-out` icon emits `sign-out` on click (visually separated from the nav items); `App.vue` already handles `@sign-out="auth.clear()"` from T004 — keep `AppSidebar` presentational, no direct store access (contracts §Events, FR-003/012)

**Checkpoint**: Sign out from the rail clears the token and drops back to the gate
with no sidebar.

---

## Phase 6: User Story 4 - Pre-auth gate has no sidebar (Priority: P2)

**Goal**: The unauthenticated token gate renders full-screen with no navigation rail;
the sidebar appears only once a token is present.

**Independent Test**: Mount with no token → full-screen gate, `app-sidebar` absent;
set a token → `app-sidebar` appears alongside main content.

### Tests for User Story 4

> Write this FIRST; it passes once T004's gate/shell split and T014's guard hold.

- [X] T013 [US4] Add the "pre-auth gate" describe block to `apps/web/test/app-sidebar.spec.ts`: with no session token, `App.vue` renders the full-screen token gate and `app-sidebar` does NOT exist; after setting a valid token (via the auth store / token input), the shell re-renders and `app-sidebar` appears (FR-013, SC-004, US4 scenarios 1–2)

### Implementation for User Story 4

- [X] T014 [US4] Confirm/tighten the render gate in `apps/web/src/App.vue`: the `v-if="!auth.token"` gate branch renders no `AppSidebar`, and `AppSidebar` lives ONLY in the authenticated `v-else` branch (structure established in T004) — ensure the T013 assertions hold with no sidebar leakage into the gate (FR-013)

**Checkpoint**: The rail never leaks into the unauthenticated screen; all four
stories independently pass.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Record the iteration and run the authoritative gates.

- [ ] T015 [P] Append an iteration-9 entry to `docs/progress.md`: header→icon-sidebar migration, the new `AppSidebar.vue` presentational component (props/events/data-test surface), `App.vue` shell rework (gate stays sidebar-free; 70px fixed rail + `margin-left` content; count query + 006 landing watch retained), badge move onto the Human queue icon, the single new `lucide-vue-next` dependency, and the `app-sidebar.spec.ts` cases + all-green gates
- [ ] T016 Run the authoritative gates per quickstart.md from repo root: `pnpm --filter @brigadir/web typecheck` (strict props/events) and `pnpm --filter @brigadir/web test` (the new spec passes alongside the existing web specs), plus root `pnpm lint`; confirm the diff touches only `apps/web/src/App.vue`, `apps/web/src/components/AppSidebar.vue`, `apps/web/package.json`, `apps/web/test/app-sidebar.spec.ts`, and `docs/progress.md` — no backend/contract/schema change (FR-015, SC-001..007)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on T001 (needs the lucide import). BLOCKS all user stories.
- **User Stories (Phase 3–6)**: All depend on Foundational (T002–T004).
  - Because US1–US3 all edit the SAME file (`AppSidebar.vue`) they run sequentially,
    in the session order US1 → US2 → US3. US4 is a `App.vue`/test-only guard and can
    slot in any time after Foundational.
- **Polish (Phase 7)**: After all desired stories are complete.

### User Story Dependencies

- **US1 (P1)**: After Foundational. Delivers the MVP navigation surface.
- **US2 (P1)**: After Foundational. Extends `AppSidebar.vue` (same file as US1) with active state + badge — sequence after US1 to avoid same-file churn.
- **US3 (P2)**: After Foundational. Adds the sign-out emit to `AppSidebar.vue`; the `App.vue` handler already exists from T004.
- **US4 (P2)**: After Foundational. Pure gate/shell guard in `App.vue` + a test; independent of US1–US3.

### Within Each User Story

- Tests written FIRST and failing before implementation (tests-first per group).
- `AppSidebar.vue` render (US1) before active/badge (US2) before sign-out (US3) — same file, so ordered.

### Parallel Opportunities

This feature is deliberately small and centers on two files, so parallelism is
limited and the `[P]` markers reflect that honestly:

- **T002** (test scaffold, `test/app-sidebar.spec.ts`) is `[P]` with **T003** (component skeleton, `AppSidebar.vue`) — different files, no ordering between them.
- **T015** (docs/progress.md) is `[P]` — it touches only docs and can be written while T016's gates run.
- Everything else is sequential: T004 depends on T003; all US1–US3 implementation tasks edit `AppSidebar.vue`; all test tasks (T005/T007/T008/T011/T013) append to the single `app-sidebar.spec.ts` and so are not mutually `[P]`.

---

## Parallel Example: Foundational Phase

```bash
# T002 and T003 touch different files with no ordering between them — run together:
Task: "Scaffold apps/web/test/app-sidebar.spec.ts (routes import + mountApp/settle helpers)"
Task: "Create apps/web/src/components/AppSidebar.vue skeleton (props/emits/lucide/NavItem/aside root)"
# Then T004 (App.vue) once T003's component exists to import.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: add `lucide-vue-next` (T001).
2. Phase 2: test scaffold + `AppSidebar` skeleton + `App.vue` shell rework (T002–T004).
3. Phase 3: US1 render + tooltips (T005–T006).
4. **STOP and VALIDATE**: authed shell shows the icon rail, tooltips name each icon, content is offset, no top header. This is the demoable MVP.

### Incremental Delivery (single session, in order)

1. Setup + Foundational → shell renders the sidebar beside offset content.
2. US1 → navigation surface (MVP).
3. US2 → active highlight + open-count badge.
4. US3 → sign-out from the rail.
5. US4 → confirm the gate stays sidebar-free.
6. Polish → progress.md entry + green `typecheck`/`test`/`lint`.

Each story is an independently testable increment; the whole set fits one implement
session because it is frontend-only and touches just two source files plus one spec.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task; here only T002/T003 and T015 qualify.
- `[Story]` labels map tasks to spec.md user stories for traceability.
- Tests-first within each group: assert against the `data-test` contract in contracts/app-sidebar.md, then implement until green.
- Element Plus interactions are driven via `$emit`/`trigger('click')` (jsdom-safe), the established convention in `test/` (006 runs-table, 007 workspace-tabs).
- Keep `AppSidebar.vue` presentational: the count query and the 006 landing `watch` STAY in `App.vue`; `openCount` flows down as a prop, sign-out flows up as an emit.
- Frontend-only (FR-015): no backend/API/contract/schema change; the diff is limited to the five files listed in T016.
- Commit after each phase (or logical group); the whole feature is one implement session.

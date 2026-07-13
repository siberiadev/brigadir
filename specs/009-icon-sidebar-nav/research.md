# Phase 0 Research: Icon Sidebar Navigation

All Technical Context items are known from the existing `apps/web` codebase; the only
genuine open questions were library/glyph and active-state derivation. Resolved below.

## R1 — Icon library and packaging

- **Decision**: Add `lucide-vue-next` and import individual icons as components
  (`import { LayoutGrid, Inbox, LogOut } from 'lucide-vue-next'`), rendered directly
  in `AppSidebar.vue`. No global registration in `main.ts`.
- **Rationale**: The iteration-9 decision (docs/plan-internal.md, row 9,
  2026-07-13) names lucide / `lucide-vue-next` explicitly, so no stack-choice
  latitude is needed. Per-icon named imports are tree-shaken by Vite and keep the
  bundle minimal; local imports avoid polluting the global component namespace the
  way `main.ts` registration would.
- **Alternatives considered**: Element Plus `@element-plus/icons-vue` (already in the
  tree transitively) — rejected because the iteration decision mandates lucide, and
  its glyph set / stroke style is the target look. Inline hand-rolled SVG — rejected
  as unmaintainable versus a curated set.

## R2 — Glyph choices (FR-004)

- **Decision**: Workspaces → `LayoutGrid` (boards/boxes glyph); Human queue →
  `Inbox` (inbox/queue glyph); Sign out → `LogOut`. Brand mark → a single-letter "B"
  text mark (not a lucide icon) sized to the ~70px rail.
- **Rationale**: These match the spec's "boards/boxes-style" and "inbox/queue-style"
  guidance (FR-004) and are stable, recognizable lucide names. The brand stays a
  wordless "B" per the spec assumption that the full wordmark is dropped at 70px.
- **Alternatives considered**: `LayoutDashboard`/`Boxes` for Workspaces and
  `ListChecks`/`ClipboardList` for the queue — all acceptable; `LayoutGrid` + `Inbox`
  chosen as the clearest boards vs. queue pair. Final glyph selection is a
  one-line swap if review prefers another.

## R3 — Active-section derivation (FR-006/FR-007)

- **Decision**: Compute active state from `useRoute().path` in the sidebar:
  Workspaces is active when `path === '/'` **or** `path.startsWith('/workspaces')`;
  Human queue is active when `path === '/human-queue'`. Any other path (e.g.
  `/runs/:id`) highlights nothing.
- **Rationale**: The 007 router nests all workspace sub-routes under
  `/workspaces/:id`, so a prefix test on `path` covers agents/runs/settings deep
  sub-routes (edge case: `/workspaces/:id/settings` keeps Workspaces active) without
  enumerating child route names. Deriving from `path` (not `route.name`) is robust to
  the run-card and future unmatched routes falling through to "none highlighted".
- **Alternatives considered**: Matching on `route.matched`/`route.name` — rejected as
  more brittle across the nested-child + redirect structure; a prefix check on `path`
  is simpler and directly expresses the FR-006 rule.

## R4 — Tooltip and badge components (FR-005/FR-008/FR-010)

- **Decision**: Wrap each icon in `el-tooltip` with `placement="right"` and the
  destination name as content. Keep the open-count badge as `el-badge` with
  `:max="99"` and `:hidden="openCount === 0"`, moved from the header link onto the
  Human queue icon.
- **Rationale**: Reuses Element Plus (already a dependency and the app's tooltip
  primitive per the spec assumption) and preserves the exact `:max="99"` / hidden-at-
  zero behavior the header badge already had (FR-010, edge cases "> 99" and "not yet
  loaded"→zero). No new state — `openCount` is still `countQuery.data.value?.open ?? 0`.
- **Alternatives considered**: A hand-rolled CSS tooltip — rejected (reinvents an
  existing, tested primitive and loses right-placement/keyboard behavior).

## R5 — Shell layout (FR-001/FR-011/FR-013)

- **Decision**: In `App.vue`, keep the `v-if="!auth.token"` token gate branch
  full-screen and sidebar-free. In the authenticated `v-else` branch, render
  `<AppSidebar>` (fixed, left, 70px, full height) plus a main region with
  `margin-left` equal to the sidebar width so no content sits under the rail. The
  count query, `authed` gate, and the 006 landing `watch` stay in `App.vue`; the
  badge count is passed to `AppSidebar` as a prop.
- **Rationale**: Owning the count query + landing rule in `App.vue` keeps the
  006 behavior literally unchanged (FR-014) and makes `AppSidebar` a pure
  presentational component (icon + tooltip + active + badge + sign-out emit), which is
  the easiest thing to unit-test. `position: fixed` + `margin-left` is the standard,
  overlap-free fixed-rail layout (SC-006).
- **Alternatives considered**: Moving the count query into `AppSidebar` — rejected
  because the 006 landing redirect also consumes that query in `App.vue`; splitting it
  would duplicate the poll and risk two sources drifting. `el-container`/`el-aside`
  fixed sidebar — viable, but a plain fixed `<aside>` gives exact 70px control with
  less Element Plus layout wrestling.

## R6 — Test strategy (FR-016)

- **Decision**: New `test/app-sidebar.spec.ts` mounts through `mountWithProviders`
  with the app's real `routes` and per-case `initialPath`, warming the lazy route
  modules by static import (the 007/`workspace-tabs.spec.ts` pattern). Assert on
  `data-test` hooks (see contracts/app-sidebar.md). Sign out asserts `auth.clear()`
  effect (token gone, gate shown, sidebar absent). The badge is driven via an msw
  handler for the count endpoint (or by seeding the query) to cover N>0, zero→no
  badge, and update-on-change.
- **Rationale**: Mirrors the established component-test convention already in
  `test/` (memory router, `flush`/`settle`, `data-test` selectors), so the new spec
  is consistent and jsdom-safe. Element Plus tooltip content is assertable without a
  real hover by checking the rendered tooltip content/`aria` surface.
- **Alternatives considered**: E2E/browser (Playwright) — out of scope; the repo's
  frontend convention is msw component tests and the spec calls for exactly those.

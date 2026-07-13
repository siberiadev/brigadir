# Implementation Plan: Icon Sidebar Navigation

**Branch**: `009-icon-sidebar-nav` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-icon-sidebar-nav/spec.md`

## Summary

Replace the top navigation header in `apps/web/src/App.vue` with a fixed, ~70px-wide
left icon sidebar (`AppSidebar.vue`) that renders, top to bottom: a compact brand
mark, icon-only nav items (Workspaces, Human queue) with right-placed Element Plus
tooltips and route-section active highlighting, and a bottom-pinned Sign out icon.
The open-human-tasks badge moves off the header text link onto the Human queue icon,
still fed by the existing `useHumanTaskCount` poll. Main content shifts right by the
sidebar width; the pre-auth token gate stays full-screen with no sidebar; the 006
open>0 landing rule is carried over untouched. Icons come from the new
`lucide-vue-next` dependency (the one new frontend package sanctioned by the
iteration-9 decision). Frontend-only — no backend, API, contract, or schema change.
Coverage is msw/`@vue/test-utils` component tests driving the app's real routes.

## Technical Context

**Language/Version**: TypeScript 5.7 (`strict: true`), Vue 3.5 SFCs, Vite 5

**Primary Dependencies**: vue-router 4 (route-section active state), Element Plus 2.9
(`el-tooltip` placement=right, `el-badge` max/hidden), `@tanstack/vue-query`
(existing `useHumanTaskCount`), Pinia (`useAuthStore`). **New**: `lucide-vue-next`
(icon glyphs) — the single new dependency approved by iteration-9.

**Storage**: N/A — frontend-only; no persisted state changes (session token stays in
sessionStorage via the existing auth store).

**Testing**: Vitest + `@vue/test-utils` + msw 2, mounted through the existing
`test/mount.ts` harness (Pinia + VueQueryPlugin + Element Plus + memory-history
router seeded at `initialPath`).

**Target Platform**: Desktop browser (modern evergreen). Mobile/responsive and
collapsible behavior are explicitly out of scope.

**Project Type**: Web application — frontend workspace `apps/web` only.

**Performance Goals**: N/A beyond normal SPA render; the sidebar is a static fixed
fixture, no new polling (reuses the ~3s count query).

**Constraints**: Fixed ~70px width, full viewport height, `position: fixed` left;
main content offset by exactly the sidebar width so nothing renders under it; the
sidebar renders only in the authenticated shell, never on the token gate.

**Scale/Scope**: One new component (`AppSidebar.vue`), one edited shell (`App.vue`),
one new dependency, one new spec file (`test/app-sidebar.spec.ts`). Two nav items +
Sign out.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Dual Source of Truth** — N/A. No orchestration state, no Jira/Postgres reads
  or writes; the badge reuses the existing count query verbatim.
- **II. Idempotency at Three Levels** — N/A. No run-triggering path touched.
- **III. System-Only Jira Writes** — N/A. No Jira writes; frontend nav only.
- **IV. Run Completion Contract** — N/A. No run lifecycle code.
- **V. Secret Isolation & Output Scrubbing** — Upheld. No secrets introduced; the
  dashboard bearer continues to live only in the auth store / sessionStorage and is
  never placed in a URL. Sign out clears it through `auth.clear()` unchanged.
- **VI. Test-Mandatory Pipeline Logic** — No pipeline logic is added, so the
  mandatory-test rule does not bind (this is a UI change, explicitly the
  lighter-coverage class in Principle VI). Nonetheless spec FR-016 mandates
  component tests; the plan delivers them, so coverage is satisfied either way.

**Technology Constraints** — Vue.js dashboard ✅; TypeScript strict, no `any` at
boundaries ✅; the new `lucide-vue-next` dependency is the explicitly sanctioned
iteration-9 addition (not an ad-hoc stack deviation, so no amendment required).
"Lazy resource resolution" is a backend DI rule — N/A to the frontend.

**Result**: PASS — no violations, Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/009-icon-sidebar-nav/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (view-model entities)
├── quickstart.md        # Phase 1 output (validation guide)
├── contracts/
│   └── app-sidebar.md   # Phase 1 output (component test-surface contract)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/web/
├── package.json                     # + lucide-vue-next dependency
├── src/
│   ├── App.vue                      # EDIT: header → sidebar shell; badge moves out
│   ├── components/
│   │   └── AppSidebar.vue           # NEW: fixed icon rail (brand, nav icons, sign out)
│   ├── composables/
│   │   └── useHumanTasks.ts         # REUSED verbatim (useHumanTaskCount badge source)
│   ├── router/index.ts              # REUSED (active-section rules derive from routes)
│   └── stores/auth.ts               # REUSED (auth.clear() for sign out)
└── test/
    ├── mount.ts                     # REUSED harness (routes + initialPath)
    └── app-sidebar.spec.ts          # NEW: rendering, tooltips, active state, badge,
                                     #      sign out, pre-auth gate has no sidebar
```

**Structure Decision**: Single-frontend change confined to `apps/web`. The nav
surface is extracted from `App.vue` into a dedicated presentational
`components/AppSidebar.vue`, keeping `App.vue` as the shell that decides gate vs.
authenticated layout and owns the count query + 006 landing watcher (unchanged). No
new directories; the component lives alongside the existing flat
`src/components/*.vue` files.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

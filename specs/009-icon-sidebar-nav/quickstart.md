# Quickstart / Validation: Icon Sidebar Navigation

Frontend-only change in `apps/web`. This guide validates the feature end-to-end via
the component-test suite and a manual dev-server smoke. See
[data-model.md](./data-model.md) and [contracts/app-sidebar.md](./contracts/app-sidebar.md)
for the entities and test surface referenced below.

## Prerequisites

- Node + pnpm workspace installed (`pnpm install` at repo root).
- New dependency added: `lucide-vue-next` in `apps/web/package.json` (run
  `pnpm --filter @brigadir/web add lucide-vue-next`, then `pnpm install`).

## Automated validation (authoritative)

From repo root:

```bash
pnpm --filter @brigadir/web typecheck   # strict TS incl. AppSidebar props/events
pnpm --filter @brigadir/web test        # vitest component suite (msw)
```

Expected: the new `test/app-sidebar.spec.ts` passes alongside the existing specs,
covering (maps to FR-016 / SC-001..007):

- **Rendering** — `app-sidebar` present with brand, `nav-workspaces`,
  `nav-human-queue`, `sidebar-sign-out`; each nav/sign-out icon has a right-placed
  tooltip with the correct name; no top nav header renders. (US1)
- **Active highlight** — mount at `/`, `/workspaces/ws-1/agents`,
  `/workspaces/ws-1/settings` → Workspaces active; at `/human-queue` → Human queue
  active; at `/runs/r-1` → neither active. (US2)
- **Badge** — count endpoint mocked to N>0 → `queue-badge` shows N (99+ when large);
  count 0 (and pre-first-poll) → no badge; changing the mocked value updates it. (US2)
- **Sign out** — activate `sidebar-sign-out` → token cleared, gate shown, sidebar
  gone. (US3)
- **Pre-auth gate** — no token → full-screen gate, `app-sidebar` absent; set token →
  sidebar appears. (US4)

## Manual smoke (optional, real browser)

```bash
pnpm --filter @brigadir/web dev
```

1. Open the app with no token → full-screen token gate, **no** sidebar (SC-004).
2. Enter a valid dashboard token → authenticated shell with the left icon rail;
   content sits to the right of the rail, nothing under it (SC-006).
3. Hover each icon → tooltip "Workspaces" / "Human queue" / "Sign out" to the right
   (SC-007). Click each nav icon → routes to that section; the active icon is
   highlighted (SC-001/002).
4. With open human tasks present, confirm the count badge sits on the Human queue
   icon and tracks the ~3s poll; resolve tasks to zero → badge disappears (SC-003).
5. Click the bottom Sign out icon → token cleared, back to the gate, no sidebar
   (SC-005).

## Done when

- `typecheck` + `test` green, including `app-sidebar.spec.ts`.
- No backend/contract/schema diff (FR-015): the change touches only
  `apps/web/src/App.vue`, `apps/web/src/components/AppSidebar.vue`,
  `apps/web/package.json`, and `apps/web/test/`.
- The 006 open>0 landing redirect still fires (unchanged) — covered by the existing
  006 behavior; not re-implemented here (FR-014).

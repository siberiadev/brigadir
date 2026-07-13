# Phase 1 Data Model: Icon Sidebar Navigation

Frontend-only feature (FR-015): **no persisted entities, no schema, no API shapes**.
The "entities" here are the client-side view models that shape `AppSidebar.vue`. No
migration and no `packages/contracts` change.

## NavItem (client-side, static config in AppSidebar)

A sidebar navigation entry. Exactly two instances, defined as a static array in the
component.

| Field       | Type                       | Notes                                                      |
|-------------|----------------------------|------------------------------------------------------------|
| `key`       | `'workspaces' \| 'human-queue'` | Stable id; drives `data-test` hook naming.            |
| `label`     | `string`                   | Tooltip text: "Workspaces", "Human queue" (FR-005).        |
| `icon`      | `Component` (lucide)       | `LayoutGrid` / `Inbox` (R2).                               |
| `to`        | `RouteLocationRaw`         | `'/'` / `'/human-queue'` (FR-006 destinations).            |
| `isActive`  | derived `(path) => boolean`| Workspaces: `path === '/' \|\| path.startsWith('/workspaces')`; Human queue: `path === '/human-queue'` (FR-006/FR-007, R3). |
| `badge?`    | `number` (Human queue only)| Open-task count, from prop; rendered via `el-badge` (FR-008). |

**Validation / rules**

- `isActive` is mutually exclusive across the two items in practice, but the
  template evaluates each independently; unmatched routes (e.g. `/runs/:id`) yield
  all-false → nothing highlighted (FR-007, SC-002).
- Only the Human queue item carries a badge; Workspaces never does.

## OpenTaskBadge (derived value, owned by App.vue, passed as prop)

| Field        | Type     | Source / rule                                                        |
|--------------|----------|----------------------------------------------------------------------|
| `openCount`  | `number` | `countQuery.data.value?.open ?? 0` — existing `useHumanTaskCount`.    |
| `hidden`     | `boolean`| `openCount === 0` (covers zero and not-yet-loaded → 0) (FR-009).      |
| `max`        | `const`  | `99` — cap display to "99+" (FR-010, edge case >99).                  |

**State transitions**: none of its own — it re-renders reactively when the ~3s count
poll delivers a new value (FR-010 / US2 scenario 5). No local mutation.

## SidebarVisibility (shell decision, App.vue)

Not an entity so much as the render gate: `auth.token` truthy → authenticated shell
(sidebar + offset main); falsy → full-screen token gate, **no sidebar** (FR-013,
US4). Sign out sets it false via `auth.clear()` (FR-012, US3). No new state — reuses
the existing `useAuthStore`.

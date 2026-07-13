# Component Contract: AppSidebar.vue

This feature exposes no network/API contract (FR-015, frontend-only). The stable
interface that tests and `App.vue` bind to is the `AppSidebar` component's props,
events, and rendered `data-test` surface. Treat these names as the contract — the
`app-sidebar.spec.ts` tests assert against them.

## Props

| Prop        | Type     | Required | Meaning                                                        |
|-------------|----------|----------|----------------------------------------------------------------|
| `openCount` | `number` | yes      | Open human-task count for the Human queue badge (0 = hidden).  |

`App.vue` computes `openCount` from the existing `useHumanTaskCount` query and passes
it down. `AppSidebar` derives active state internally from `useRoute()` — no `active`
prop.

## Events

| Event      | Payload | Emitted when                                              |
|------------|---------|-----------------------------------------------------------|
| `sign-out` | none    | The Sign out icon is activated. `App.vue` handles it by calling `auth.clear()` (FR-012). |

> Implementation note: the component MAY instead call the auth store directly; if so
> the sign-out test asserts the store effect rather than the emit. Pick one and keep
> the test aligned. Recommended: emit `sign-out`, keep `AppSidebar` presentational.

## Rendered `data-test` surface (assert on these)

| `data-test`                     | Element                                   | Covers            |
|---------------------------------|-------------------------------------------|-------------------|
| `app-sidebar`                   | the fixed rail root `<aside>`             | FR-001, US4       |
| `sidebar-brand`                 | brand "B" mark at top                     | FR-003            |
| `nav-workspaces`                | Workspaces icon nav item (RouterLink)     | FR-003/004/006    |
| `nav-human-queue`               | Human queue icon nav item (RouterLink)    | FR-003/004/006    |
| `nav-workspaces--active` (class or attr) | active state marker on Workspaces | FR-006, SC-002    |
| `nav-human-queue--active` (class or attr) | active state marker on Human queue | FR-006, SC-002   |
| `queue-badge`                   | `el-badge` on the Human queue icon        | FR-008/009/010    |
| `sidebar-sign-out`              | Sign out icon, bottom-pinned              | FR-003/012, US3   |

> Active state MAY be expressed as an `is-active` class or `data-active="true"`
> attribute on the nav item rather than a distinct `data-test` per item — the test
> reads whichever the component uses. Keep the mechanism consistent across both items.

## Tooltip contract

Each of `nav-workspaces`, `nav-human-queue`, `sidebar-sign-out` is wrapped in an
`el-tooltip` with `placement="right"` whose content is exactly "Workspaces",
"Human queue", "Sign out" respectively (FR-005). Tests assert the tooltip content is
present in the rendered output.

## Behavioral contract (what the tests pin)

1. **Render** — mounting the authenticated shell shows `app-sidebar` with brand + two
   nav icons + sign out; no top nav header exists (SC-001).
2. **Active** — on `/` and `/workspaces/*`, Workspaces is active and Human queue is
   not; on `/human-queue`, the reverse; on `/runs/:id`, neither (FR-006/007, SC-002).
3. **Badge** — `openCount` > 0 renders `queue-badge` with the value (capped 99+);
   `openCount === 0` renders no visible badge; a changed prop updates it
   (FR-008/009/010, SC-003).
4. **Sign out** — activating `sidebar-sign-out` clears the token and returns to the
   gate with no sidebar (FR-012, SC-005).
5. **Gate** — with no token, `App.vue` renders the full-screen gate and `app-sidebar`
   is absent; with a token it appears (FR-013, SC-004).

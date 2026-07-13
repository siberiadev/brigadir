# UI Contract: Workspace Tabs Navigation

This feature exposes no network/API contract (frontend-only, FR-014). Its "contract" is the
set of client routes, component props, and `data-test` selectors that other code and the
component tests depend on. Kept stable so deep-links (FR-009) and tests don't break.

## Route contract

| Path | Name | Component | Active tab | Notes |
|------|------|-----------|-----------|-------|
| `/workspaces/:id` | `workspace` | `WorkspacePage` (redirect child) | — | Redirects to `agents` (default tab, FR-006). |
| `/workspaces/:id/agents` | `agents` | `WorkspacePage` → `AgentsList` | Agents | **Shipped deep-link — must not change** (FR-009). |
| `/workspaces/:id/runs` | `runs` | `WorkspacePage` → `Runs` | Runs | **Shipped deep-link — must not change** (FR-009). |
| `/workspaces/:id/<unknown>` | — | redirect | Agents | Unknown-tab fallback (FR-012). |
| `/workspaces/:id/settings` | `workspace-settings` | `WorkspaceSettings` | n/a | **Unchanged**; not a tab; resolves ahead of the unknown-tab redirect. |
| `/runs/:id` | `run-card` | `RunCard` | — | Unchanged. |
| `/` , `/human-queue` | `workspaces`, `human-queue` | unchanged | — | Unchanged. |

`agents` and `runs` are **nested children** of the `/workspaces/:id` → `WorkspacePage` record,
so switching between them reuses the `WorkspacePage` instance and swaps only the nested
`<router-view>` (FR-007). Route params merge, so `:id` reaches the children.

## Component props

### `WorkspacePage.vue` (view)
- Props: `{ id: string }` (from `props: true`).
- Renders: `<WorkspaceTabs :id="id" :tabs="…" />` then `<router-view />`. No duplicate
  workspace-name heading (the list bodies already render one — FR-011).

### `components/WorkspaceTabs/WorkspaceTabs.vue` (shared, reusable — FR-013)
- Props:
  - `id: string` — workspace id used to build tab route targets.
  - `tabs: { name: string; label: string }[]` — ordered tab list; default caller passes
    `[{ name: 'agents', label: 'Agents' }, { name: 'runs', label: 'Runs' }]`.
- Behavior: active tab = `computed` from `useRoute()`; `@tab-change` →
  `router.push({ name, params: { id } })`. No internal mutable active-tab state (URL is source
  of truth, FR-008).

### `AgentsList.vue`, `Runs.vue`
- Props unchanged: `{ id: string }`. **No edits** (FR-011).

## `data-test` selector contract (for component tests)

Reuse existing selectors where present; add the few below.

| Selector | Element | Purpose |
|----------|---------|---------|
| `workspaces-table` | `el-table` in `WorkspaceList` | existing — target for `@row-click`. |
| `workspace-tabs` | `WorkspaceTabs` root | new — assert the tab strip renders. |
| `workspace-tab-agents` / `workspace-tab-runs` | tab labels | new — click to switch tabs. |
| `toggle-pause-${id}` | Start/Pause button | existing — assert click does **not** navigate (FR-004). |
| `agents-table` | `el-table` in `AgentsList` | existing — assert Agents body is shown. |
| `runs-table` / `runs-empty` | `Runs` body | existing — assert Runs body is shown. |

Removed from `WorkspaceList` rows: the Agents and Runs `RouterLink`/`el-button` controls
(FR-001). Settings button retained (opens the existing settings dialog, `@click.stop`).

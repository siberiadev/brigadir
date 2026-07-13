# Phase 1 Data Model: Workspace Tabs Navigation

No database entities, no API payloads, no `packages/contracts` changes (FR-014). The only
"model" is client-side view/navigation state derived entirely from the router. Documented here
so tasks and tests share one vocabulary.

## Entities (view-model only)

### WorkspaceTab (static, in-code)

One selectable tab on the workspace page. A fixed list of two, defined where `WorkspaceTabs`
is used — not fetched, not persisted.

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Vue Router **named route** for the tab (`'agents'` \| `'runs'`). Used both to render the link and to derive active state. |
| `label` | `string` | Display text (`'Agents'` \| `'runs'` → `'Runs'`). |

Order is significant: `[Agents, Runs]` (FR-005). Exactly one is active at a time.

### ActiveTab (derived)

Not stored — a `computed` over the current route.

- **Source of truth**: `useRoute().name` (the matched child route name).
- **Value**: `'agents'` | `'runs'`.
- **Fallback**: any route that is not one of the two child routes resolves — via the router's
  empty-path and `:catchAll(.*)*` redirects — to `agents` (FR-006, FR-012). So `ActiveTab` is
  never undefined on the workspace page.
- **Transition**: selecting a tab calls `router.push({ name, params: { id } })`; the route
  change updates `ActiveTab`. There is no separate mutable state to keep in sync (FR-008).

### WorkspaceRoute params

| Param | Source | Consumers |
|-------|--------|-----------|
| `id` | path segment `/workspaces/:id/…` | `WorkspacePage` (for `WorkspaceTabs` links), `AgentsList`/`Runs` via merged-param `props: true`, tab `router.push`. |

## State transitions

```text
WorkspaceList
   │  row click (not on an action control)
   ▼
/workspaces/:id           ──redirect──▶ /workspaces/:id/agents   (Agents active)
                                              │  ▲
                          tab: Runs  push ────┘  └──── tab: Agents push
                                              ▼
                                        /workspaces/:id/runs      (Runs active)

Direct nav / deep link:
   /workspaces/:id/agents  ▶ Agents active
   /workspaces/:id/runs    ▶ Runs active
   /workspaces/:id/<other> ▶ redirect ▶ Agents active   (unknown-tab fallback)
   /workspaces/:id/settings ▶ WorkspaceSettings          (unchanged, not a tab)

Browser Back after a tab switch ▶ previous tab of the same workspace (history entry).
```

## Validation / invariants

- **Exactly two tabs** rendered on the workspace page (FR-005); no Settings tab.
- **Active tab always defined** on the workspace page (redirects guarantee it) (FR-006/FR-012).
- **URL ⇔ tab are consistent**: because active state is derived from the route, they cannot
  drift (FR-008).
- **Row action controls never navigate**: Settings and Start/Pause stop propagation (FR-004).
- **Lists unchanged**: `AgentsList` and `Runs` receive the same `id` prop and behave exactly
  as today (FR-011).

# Phase 0 Research: Workspace Tabs Navigation

All decisions are frontend-only and biased to the simplest option that satisfies the spec's
functional requirements. Existing code was read (not assumed): `router/index.ts`,
`WorkspaceList.vue`, `AgentsList.vue`, `Runs.vue`, `WorkspaceSettings.vue`, `App.vue`,
`test/mount.ts`, `test/handlers.ts`, `test/workspace-list.spec.ts`, and the `useAgents` /
`agentsApi` composables.

## R1 — Route shape: nested children vs `?tab=` + redirects

**Decision**: Keep the two shipped paths `/workspaces/:id/agents` and `/workspaces/:id/runs`
verbatim and make them **nested children** of a single parent route `/workspaces/:id` whose
component is the new `WorkspacePage.vue`. The parent renders the tab strip + a nested
`<router-view>`; the child route (`agents` | `runs`) renders `AgentsList` | `Runs`.

Router (final):

```text
/workspaces/:id            → WorkspacePage (props: true)
   ''       (name: workspace)      → redirect → { name: 'agents', params: { id } }   # default tab
   'agents' (name: agents)         → AgentsList (props: true)
   'runs'   (name: runs)           → Runs      (props: true)
   ':catchAll(.*)*'                → redirect → { name: 'agents', params: { id } }   # unknown tab (FR-012)
/workspaces/:id/settings   → WorkspaceSettings (props: true)   # UNCHANGED, stays top-level
/runs/:id                  → RunCard          # unchanged
/human-queue, /            → unchanged
```

**Rationale**:
- **FR-009 by construction** — the canonical addresses are literally the same strings that
  ship today, so every existing link keeps resolving; nothing needs a redirect shim.
- **FR-007 for free** — navigating `agents ⇄ runs` shares the parent record, so Vue Router
  **reuses** the `WorkspacePage` instance and swaps only the nested `<router-view>`. No full
  page reload, no app-shell remount.
- **FR-010 for free** — each tab is a real history entry; browser back/forward moves between
  tabs of the same workspace with no custom code.
- **FR-008 / single-source-of-truth** — the active tab is derived from the matched route, not
  a local ref; bookmarking/sharing/restoring works because the URL *is* the state.
- Route params merge across matched records, so child `props: true` still delivers `id` to
  `AgentsList` / `Runs` (they already `defineProps<{ id: string }>()`), and the parent gets
  `id` too.

**Alternatives considered**:
- **`/workspaces/:id?tab=agents|runs` + redirects from the two old paths** — rejected: invents
  a new canonical URL, needs redirect records for the two shipped paths (more moving parts,
  the opposite of FR-009-by-construction), and query-param tab state is easy to desync from
  the list.
- **One component matched by both flat routes, manual `v-if` swap inside** — rejected: the
  parent would remount-or-branch manually and re-implement what a nested `<router-view>` does
  natively; more code, no benefit.

**Risk / verify at implementation**: the nested `:catchAll(.*)*` redirect must not swallow
`/workspaces/:id/settings`. Vue Router ranks a static segment (`settings`, on its own
top-level record) above a param/wildcard, so `/settings` wins. This is asserted by a
resolution test (see quickstart) so a future reorder can't silently regress it.

## R2 — Tabs component: `el-tabs` wrapper vs hand-rolled strip

**Decision**: A small shared `components/WorkspaceTabs/WorkspaceTabs.vue` wrapping Element
Plus **`el-tabs`** (label-only `el-tab-pane`s; the bodies come from the parent's
`<router-view>`, not from the panes). It is **router-driven**: the active tab name is a
`computed` from `useRoute()`, and `@tab-change` does `router.push({ name, params: { id } })`.
No local mutable "active tab" ref.

Props: `id: string` and `tabs: { name: string; label: string }[]` (default caller passes
`[{ name: 'agents', label: 'Agents' }, { name: 'runs', label: 'Runs' }]`). Keeping `tabs` a
prop satisfies **FR-013** ("shared, reusable … reused as workspace-level navigation grows" —
iteration 8 context) without over-engineering.

**Rationale**: Element Plus is the established dashboard toolkit (FR-015) — `el-tabs` gives
keyboard/aria/active-underline behavior for free and matches the look of `el-table`,
`el-radio-group`, etc. already in `Runs.vue`. Driving `v-model` off the route keeps the URL
authoritative.

**Alternatives considered**: hand-rolled `<button>` strip — rejected: re-implements
accessibility and active-state styling that `el-tabs` already provides, and drifts from house
style. Using `el-tab-pane` *content* for the lists — rejected: it would duplicate the routing
already done by the nested `<router-view>` and couple tab rendering to list mounting.

## R3 — Row click vs. row action controls (FR-003 / FR-004)

**Decision**: On the `WorkspaceList` `el-table`, add `@row-click="openWorkspace"` →
`router.push({ name: 'agents', params: { id: row.id } })`. Remove the two `RouterLink`
Agents/Runs buttons (FR-001). Add **`@click.stop`** to the remaining Settings and Start/Pause
buttons so their native click does not bubble to the table's row handler (FR-004). Signal
clickability with `cursor: pointer` on table rows — the exact pattern `Runs.vue` already uses
(`.el-table { cursor: pointer }` + `@row-click`).

**Rationale**: `el-table` emits `row-click` from a native click on the row; `@click.stop` on
an inner control halts propagation before the row handler sees it, so action buttons act
without navigating. Mirroring `Runs.vue` keeps the interaction idiom consistent across the app.

**Alternatives considered**: cell-index exclusion inside the row-click handler (ignore clicks
whose target is the actions column) — rejected: brittle (depends on column position/DOM
walking) versus a declarative `.stop`. Wrapping the name cell in a `RouterLink` only — rejected:
the spec wants the **whole row** clickable (FR-003).

## R4 — Keep-alive / remount semantics

**Decision**: Do **not** introduce `<keep-alive>`. Switching tabs remounts the child
(`AgentsList` or `Runs`); the parent `WorkspacePage` and the App.vue shell stay mounted. The
edge case only forbids remounting the *app shell* and refetching *unrelated* data — neither
happens here. TanStack Query serves the just-viewed tab's data from cache on return, so a
remount is effectively instantaneous and triggers no unrelated network work. The 006 polling
composables are not touched.

**Rationale**: YAGNI — `<keep-alive>` adds state-retention surface and lifecycle subtlety for
no observed problem. Add it only if a concrete regression appears (none expected).

**Alternatives considered**: `<keep-alive>` around the nested `<router-view>` — rejected as
premature; it would also retain filter/pagination state across tab switches in ways not asked
for and could mask stale data.

## R5 — Test harness extension (`test/mount.ts`) and handler reuse

**Decision**: Extend `mountWithProviders` to accept optional `routes` and `initialPath`
options. When `routes` is provided it builds the `createMemoryHistory` router from them and
`await router.push(initialPath)` + `router.isReady()` before mount; otherwise it keeps today's
catch-all stub (backward compatible with every existing spec). Navigation/deep-link tests pass
the app's real workspace routes (or a faithful subset) so `route.name`-derived tab state and
redirects are exercised for real. **Reuse the existing 006 msw handlers** — `/api/agents?workspace=`
and `/api/workspaces/:id/runs(/cost)` are already faked (`sampleAgent`, `sampleRunList`,
`sampleRunCost`); `handlers.ts` is extended only if a scenario needs a second workspace/agent
row.

**Rationale**: The planning constraint is to extend `apps/web/test/{mount,handlers}.ts`, not
fork a new harness. A real router is required to assert deep-link resolution, tab swap, and
unknown-tab fallback; keeping the default path untouched avoids churn in the ~12 existing
specs.

**Alternatives considered**: building a bespoke router inside each test — rejected: duplicates
setup and diverges from the shared-harness convention. Stubbing `AgentsList`/`Runs` — rejected
where the test asserts the *body swapped*; real children (with faked API) prove the swap.

## Cross-cutting notes

- **Duplicate heading (accepted tradeoff)**: `AgentsList`/`Runs` each render their own
  `<h2>Agents — {name}</h2>` / `<h2>Runs — {name}</h2>`. Because FR-011 forbids editing the
  lists, `WorkspacePage` keeps its own chrome minimal (just the tab strip, no repeated
  workspace title) so there is a single workspace-name heading on screen. Deduping headings is
  explicitly out of scope and can be a later cleanup.
- **Settings wording**: the spec was amended to say Settings opens a "view" (not "dialog"),
  but FR-002 keeps Settings behavior **unchanged**, and the planning constraints scope
  Settings out. This plan therefore leaves the row Settings action exactly as it is today
  (opens the `WorkspaceSettings` dialog from the list) and does not add a Settings tab
  (FR-005 = exactly two tabs). Converting Settings to a standalone page is not in this feature.
- **No consumer edits**: run card, human queue, and navbar are unchanged; they keep resolving
  because the named routes `agents`/`runs` and their paths are preserved (R1).

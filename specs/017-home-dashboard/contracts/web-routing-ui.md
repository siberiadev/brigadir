# Contract — Web routing & Home page composition (US1 + all blocks)

Not an HTTP contract — the UI-facing behavioral contract for the routing change and the page's
block composition. Visual authority: `docs/mockups/home-dashboard.html` (composition/fields/
status-colors authoritative; spacing/copy/fake-data directional).

## Routing (`apps/web/src/router/index.ts`)

| Route | Before | After |
|---|---|---|
| `/` | name `workspaces` → `WorkspaceList.vue` | `redirect: '/home'` |
| `/home` | — | name `home` → lazy `views/HomeDashboard.vue` |
| `/workspaces` | — | name `workspaces` → `WorkspaceList.vue` (route **name preserved** so every `router.push({name:'workspaces'})` keeps working) |
| `/workspaces/:id/*` | children (runs/agents/human-queue/settings) | unchanged (static `/workspaces` outranks `:id`; list route is exact) |
| `/runs/:id`, `/human-queue`, `/settings/*` | | unchanged |

**Removed behavior**: the one-shot `/` → `/human-queue` auto-redirect in `App.vue` (fired when
`open > 0`). Superseded by the Home hero (FR-001); flagged in plan.md as the only behavioral
deletion.

Auth: unchanged — the `App.vue` token gate wraps all routes; no per-route guard (FR-004).

## Sidebar (`apps/web/src/components/AppSidebar.vue`)

- New FIRST nav item: Home — lucide `House`, wrapped in `<AnimatedIcon>` (standard sidebar
  hover treatment, `anim-trigger` on the link), `to: '/home'`,
  `isActive: path === '/home'`.
- Workspaces item: `to: '/workspaces'`,
  `isActive: path === '/workspaces' || path.startsWith('/workspaces/')`.
- Human-queue badge (`openCount` prop from `App.vue`'s existing `useHumanTaskCount`): unchanged.

## Page composition (`views/HomeDashboard.vue` + `components/Home/`)

Layout hierarchy (mock-authoritative): tiles row → two columns (left: hero + needs-attention;
right: live runs + spend) → workspace grid. Components and their data sources:

| Block | Component | Data | Poll |
|---|---|---|---|
| Stat tiles | `Home/StatTiles.vue` | `useHomeSummary()` → `GET /api/home/summary` | 5 s |
| Human-queue hero | `Home/HumanQueueHero.vue` | existing `useHumanTasks('open', {page:1, page_size:5})` — count = response `total` | 4 s (existing) |
| Needs attention | `Home/NeedsAttentionList.vue` | `useGlobalRuns({status:'failed,timed_out', finished_within:'24h', limit:10})` | 5 s |
| Live runs | `Home/LiveRunsList.vue` | `useGlobalRuns({status:'running,queued', limit:10})` | 5 s |
| Spend | `Home/SpendCard.vue` | from `useHomeSummary()` (all 3 periods preloaded; switcher = local state, no refetch) | — |
| Workspace grid | `Home/WorkspaceCardsGrid.vue` | `useHomeWorkspaces()` → `GET /api/home/workspaces` | 15 s |

All list queries use `placeholderData: (prev) => prev` (FR-023).

## Behavior contracts per block

- **Tiles**: 4 counters from ONE response; failed-24h tile gets danger styling when > 0
  (`--el-color-danger*` only); running tile reuses the `RunStatusTag` pulse-dot pattern.
  Sub-captions (mock's "across 2 workspaces" etc.) optional.
- **Hero**: most prominent block; header count chip + "Open queue →" → `/human-queue`; each row
  → `/runs/${run_id}` when `run_id` present (else no link); rows show `title`, ticket key
  (when present), agent name, workspace name, `relativeAge(created_at) + ' ago'`; empty state
  = positive `el-empty` (count 0).
- **Needs attention**: rows `RunStatusTag` + ticket key/summary + agent + workspace +
  `relativeAge(finished_at)`; row click → `/runs/:id`; header "All runs →" links to an existing
  runs view; empty = positive message.
- **Live runs**: running rows tick via `useNow()` 1 s + `max(0, now − started_at)`
  (`formatDuration`), clamp ≥ 0; queued rows show waiting age from `created_at`; ordering comes
  from the server (no client sort).
- **Spend**: `el-radio-group` period switcher (24h default) like `Runs.vue`; figure via
  `formatCostUsd`; zero renders `$0.00`.
- **Workspace cards**: name, `project_key` chip, paused (`enabled === false` → `el-tag` paused +
  muted card) / active tag, `agent_count`, last run (`RunStatusTag` + relative time, or
  "no runs yet"), danger marker when `attention_24h > 0` else calm note; card click →
  workspace page (`{name:'runs', params:{id}}`); zero workspaces → existing empty-state
  guidance.
- **Degradation**: each block renders its own `isError` state; sibling blocks unaffected
  (FR-024). No block ever blanks to nothing while refetching (placeholderData).

## Conventions (hard gates)

Colors only via `--el-color-*`; icons lucide + static outside the sidebar; no bespoke
pagination anywhere on Home; scoped SCSS with `$space-*` tokens; `data-test` attributes on
interactive/asserted elements following existing naming (`runs-empty`, `queue-badge`, …).

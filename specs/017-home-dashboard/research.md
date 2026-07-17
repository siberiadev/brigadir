# Research — Feature 017: Home Dashboard

**Date**: 2026-07-17. All findings verified against the working tree (file:line refs current as of commit `662aff8`).

## R1. Where the new endpoints live & how they're guarded

**Decision**: New `HomeController` in `apps/backend/src/dashboard/` with `@Controller('api/home')` + class-level `@UseGuards(DashboardTokenGuard)`, registered in `DashboardModule` (`apps/backend/src/dashboard/dashboard.module.ts:26-42`). The global runs listing goes into the existing `RunsController` (`apps/backend/src/dashboard/runs.controller.ts`, bare `@Controller()` — routes carry full paths) as `@Get('api/runs')`, which composes cleanly with the existing `@Get('api/runs/:id')` run card route.

**Rationale**: Matches every existing dashboard controller (per-controller `api/...` prefixes, no global prefix; guard applied at class level, e.g. runs.controller.ts:29). A cross-workspace runs list is a general runs capability, not a Home-only view — `GET /api/runs` is the natural address and keeps HomeController purely aggregate.

**Alternatives considered**: (a) everything under `api/home/*` — rejected: the global runs list will be the target of the "view all" links and future pages, it shouldn't be named after one consumer; (b) a separate Nest module — rejected: DashboardModule is the established single home for token-guarded UI endpoints.

## R2. Shape of the global runs listing (FR-014/FR-017)

**Decision**: `GET /api/runs?status=<csv>&finished_within=24h&limit=10`.
- `status` — **required**, comma-separated subset of the existing `RunStatusSchema` vocabulary (`packages/contracts/src/runs.schema.ts:16-25`). Missing/empty/unknown value → 422 (`validationError` from `dashboard.errors.ts`). This enforces the "no unbounded listing" constraint at the contract level.
- `finished_within` — optional, reuses `RunCostPeriodSchema` (`'24h'|'7d'|'30d'`); filters `finished_at >= now() - interval`. The Home page passes `24h` for needs-attention and omits it for live runs.
- `limit` — optional, default 10, hard max 50, `z.coerce` + `.catch(10)` in the query schema (server clamps regardless of client). No `page`/`offset`: this is the sanctioned whole-list/top-N consumer — response is `{ items, total }` (total = count matching the filter, so the UI can say "view all (N)"), NOT the `makePaginatedResponseSchema` envelope.
- **Deterministic ordering** (fixed, documented in the contract, no `order` param): status rank first (`running` → 0, `queued` → 1, terminal → 2), then within rank: running by `started_at ASC NULLS LAST` (longest-running first), queued by `created_at ASC` (longest-waiting first), terminal by `finished_at DESC NULLS LAST` (most recently finished first); final tie-break `id ASC`. One SQL `ORDER BY` with CASE expressions. This single rule serves both Home blocks exactly and stays deterministic for any status combination.

**Rationale**: Mirrors the existing workspace-scoped list's join shape (runs.controller.ts:84-91: LEFT JOIN tickets — ticketless setup runs must stay visible; INNER JOIN agents) plus a new INNER JOIN workspaces for the workspace name. Required-status + capped-limit is exactly the spec's mandate. `{items,total}` keeps FR-025 (no pagination envelope on dashboard lists) while still powering "view all" counts.

**Alternatives considered**: (a) an `order` query param — rejected: two callers with fixed needs, YAGNI, and it widens the unbounded-query surface; (b) two dedicated endpoints (`/api/home/attention`, `/api/home/live`) — rejected: spec explicitly says one listing with different status filters (FR-017); (c) reusing the paginated envelope with `page_size` — rejected: FR-025 forbids pagination semantics on dashboard blocks, and `total` alone carries the "more exist" signal.

## R3. `GET /api/home/summary` contents (FR-010, FR-021)

**Decision**: One response carrying **all tile counters and all three spend figures**:

- counters: `running`, `queued`, `attention_24h` = `{ failed, timed_out }` (split — the mock's tile sub-line "1 failed · 1 timed out" is free), `human_open`;
- spend: `{ "24h": {total_cost_usd, run_count}, "7d": {...}, "30d": {...} }` — all periods in one response, so the period switcher is pure client-side state with zero refetch.

Backend computes this with 3 parallel queries: (1) live counts — `GROUP BY status` over `status IN ('running','queued')`; (2) attention counts — `status IN ('failed','timed_out') AND finished_at >= now() - interval '24 hours'` grouped by status; (3) spend — single row with `SUM(cost_usd) FILTER (WHERE created_at >= now() - interval 'X')` + matching `COUNT(*) FILTER` per period; plus (4) the open human-task count (same query as `HumanTasksController.count`, human-tasks.controller.ts:133-140).

**Window columns**: failure tiles/list use `finished_at` (spec language: "finished failed/timed_out within 24h"); **spend keeps `created_at`** — the existing per-workspace cost endpoint windows on `created_at` (runs.controller.ts:122-133), and FR-021/SC-004 require the platform figure to equal the sum of per-workspace figures, so the window column MUST match.

**Rationale**: FR-010 mandates a single response for tiles; folding spend in (explicitly allowed by the feature description) makes the switcher instant and keeps Home at 4 data sources total. `total_cost_usd` stays a string (Postgres numeric round-trip, same as `RunCostResponseSchema`, runs.schema.ts:75-82).

**Alternatives considered**: (a) spend as a separate `GET /api/home/cost?period=` — rejected: extra endpoint + refetch on switch for no gain; (b) windowing spend on `finished_at` for "correctness" — rejected: breaks SC-004 consistency with the existing per-workspace figure.

## R4. Workspace cards data (FR-018/FR-020) — the decision delegated by the spec

**Decision**: New dedicated `GET /api/home/workspaces` returning `{ items: [...] }` (all workspaces, no pagination — dashboard whole-list consumer; ordered `created_at ASC` like the existing list, workspaces.controller.ts:70). Each item: `id`, `name`, `project_key`, `board_type`, `enabled`, `agent_count`, `last_run` (`{run_id, status, started_at, finished_at, created_at} | null`), `attention_24h` (failed+timed_out count in last 24h). Computed with 4 batched queries (workspaces; agents `COUNT(*) GROUP BY workspace_id`; last runs via `DISTINCT ON (workspace_id) ... ORDER BY workspace_id, created_at DESC` — covered by the existing `runs_workspace_created` index, libs/database/src/schema/runs.ts:50-65; attention counts `GROUP BY workspace_id`) merged in memory. **No per-card fan-out, no N+1.**

**Rationale over extending `GET /api/workspaces`**: the existing list is paginated (`makePaginatedResponseSchema`) and built by a per-row `toResponse` N+1 (workspaces.controller.ts:59-81) serving settings-heavy consumers (credential status, repositories, bot email). The card grid needs a different, lighter projection + aggregates; bolting aggregates onto `WorkspaceResponse` would bloat every existing consumer, deepen the N+1, and violate FR-025's no-pagination rule for the grid. A dedicated read model is smaller in every dimension. Paused state = `settings.enabled === false` (jsonb read via existing helpers; there is NO paused column — workspaces.controller.ts:121,416).

**Alternatives considered**: extending `WorkspaceResponse` with optional aggregates behind `?include=stats` — rejected: conditional response shapes fight the strict-schema convention (`.strict()` everywhere) and complicate the contract tests.

## R5. No DB schema changes — confirmed viable (FR-029)

**Decision**: Zero migrations. No new indexes.

**Rationale**: New queries and their index situation: (a) global live runs — `status IN ('running','queued')` is a tiny set by construction (bounded by executor `max_parallel_runs`); seq scan is irrelevant at internal-tool scale; (b) failed-in-24h — no index on `status`/`finished_at`, full scan of runs bounded by table size (thousands of rows for this team); (c) per-workspace last-run uses existing `runs_workspace_created`; (d) spend FILTER aggregate — same full-scan cost the per-workspace cost endpoint already pays per workspace. **Escalation path documented**: if the runs table ever grows to where p95 suffers, add a partial index (e.g. `ON runs (finished_at DESC) WHERE status IN ('failed','timed_out')`) — that is a §3 schema change and per project rule 5 requires updating `docs/architecture.md` first; it is NOT part of this feature.

## R6. Frontend page composition & routing

**Decision**:
- Router (`apps/web/src/router/index.ts`): `/` becomes `{ path: '/', redirect: '/home' }`; new `/home` (name `home`) → lazy `HomeDashboard.vue`; workspace list moves to `/workspaces` keeping route **name `workspaces`** so every existing `router.push({name:...})` keeps working. Existing children under `/workspaces/:id` are untouched (`:id` cannot equal the static `/workspaces` — vue-router ranks static segments higher, and the list route is `exact` path `/workspaces`).
- `AppSidebar.vue`: prepend Home nav item — lucide `House` icon wrapped in `<AnimatedIcon effect="dip">`... (exact effect chosen in implementation; standard treatment per UI convention), `anim-trigger` on the link, `isActive: path === '/home'`; change workspaces item to `to: '/workspaces'`, `isActive: path === '/workspaces' || path.startsWith('/workspaces/')`.
- **Remove the one-shot `/` → `/human-queue` redirect** in `App.vue:38-45` (it fired when `open > 0`). Home now IS the landing answer to "does the system need me" — the hero shows the same queue more prominently. Keeping both would bounce users past the new landing page and contradict FR-001.
- View: `src/views/HomeDashboard.vue`; blocks as components in `src/components/Home/`: `StatTiles.vue`, `HumanQueueHero.vue`, `NeedsAttentionList.vue`, `LiveRunsList.vue`, `SpendCard.vue`, `WorkspaceCardsGrid.vue`. Element Plus `el-card`/`el-tag`(via `RunStatusTag`)/`el-empty`; layout per mock hierarchy (tiles row → hero+attention | live+spend columns → grid) with scoped SCSS using `$space-*` tokens and `--el-color-*` vars only.

**Rationale**: Matches the repo's routing/name conventions and the mock's authoritative hierarchy; removing the App.vue auto-redirect is the only behavioral deletion, justified because its purpose (surface pending human work on landing) is subsumed by the hero (spec US1). Flagged for reviewer attention in plan.md.

## R7. Data-access composables & polling

**Decision** (new composables in `src/composables/`, API fns in `src/api/home.ts` + an addition to `src/api/runs.ts`):

| Composable | Key | Interval | Notes |
|---|---|---|---|
| `useHomeSummary()` | `['home','summary']` | 5000 | tiles + spend; `placeholderData: (prev) => prev` |
| `useGlobalRuns(params)` | `['runs','global',params]` | 5000 | both lists; `placeholderData: (prev) => prev` |
| `useHomeWorkspaces()` | `['home','workspaces']` | 15000 | grid changes slowly |
| hero reuses `useHumanTasks('open', {page:1,page_size:5})` | existing `['human-tasks','open',...]` | 4000 (existing) | count in hero header comes from the SAME list response's `total` — internally consistent |

Intervals follow existing precedent: runs/cost poll at 5000 (`useRuns.ts:19`, `useRunsCost`), open queue at 4000 (`useHumanTasks.ts:32`), count at 3000. Live ticker: reuse `useNow()` (1s) + `formatDuration(Math.max(0, now - Date.parse(started_at)))` exactly as `Runs.vue:57-63` (clamped → FR-016 clock-skew edge). Relative times via `relativeAge()` + " ago" (`src/utils/date.ts:13-22`); money via `formatCostUsd` (`src/utils/currency.ts`). Per-block error degradation (FR-024): each block renders from its own query state (`isError` → in-block error note; TanStack keeps blocks independent by construction).

**Alternatives considered**: driving the hero from `useHumanTaskCount` + separate list — rejected: two sources can disagree; the list response's `total` field IS the count (envelope from the existing paginated endpoint — reusing it read-only is fine; FR-025 forbids adding pagination *UI*, not consuming an existing envelope).

## R8. Contracts package additions

**Decision**: New `packages/contracts/src/home.schema.ts` (exported from `index.ts`): `HomeSummaryResponseSchema`, `HomeWorkspaceItemSchema` + `HomeWorkspacesResponseSchema`, `GlobalRunsQuerySchema`, `GlobalRunListItemSchema` (= existing `RunListItemSchema` fields + `workspace: {id, name}` + `finished_at`) + `GlobalRunsResponseSchema` (`{items, total}`). Style: `z.object({...}).strict()`, snake_case, `export type X = z.infer<...>`, enums reuse `RunStatusSchema`/`RunCostPeriodSchema` — never re-declared. Contract tests colocated `home.schema.spec.ts` following `dashboard.schema.spec.ts` (safeParse + path-qualified issue assertions; no-credential-leak style checks not needed — no secrets in these shapes).

**Note**: `GlobalRunListItemSchema` adds `finished_at` (the needs-attention list shows finish time; the existing `RunListItemSchema` (runs.schema.ts:48-64) carries `started_at`/`duration_ms` but not `finished_at`).

## R9. Test strategy mapping

**Decision**:
- **Contract**: `packages/contracts/src/home.schema.spec.ts` — valid/invalid parses for every new schema incl. status-CSV validation and limit clamping.
- **Backend integration** (mirror `test/integration/runs-cost.spec.ts` structure — `startDatabase`/`startRedis` from harness, `seedPipeline`, direct `schema.runs`/`schema.humanTasks` inserts with controlled timestamps, boot real `BackendAppModule`, fetch with `Bearer ${TEST_DASHBOARD_TOKEN}`): new specs `home-summary.spec.ts` (counters incl. 24h boundary exclusion, spend equals per-workspace sums, zero states), `runs-global.spec.ts` (status required → 422, limit clamp, ordering rule incl. running/queued/terminal mix across 2 workspaces, `finished_within` filter, ticketless runs listed), `home-workspaces.spec.ts` (aggregates per workspace, paused flag, workspace with no runs, no-N+1 not asserted but queries batched by design). Auth: add the three new routes to the guard coverage pattern of `dashboard-auth.spec.ts`.
- **Web component** (in `apps/web/test/`, `mountWithProviders` + msw `server.use(...)` per `test/runs-table.spec.ts` pattern): `home-dashboard.spec.ts` (tiles render counters, hero rows/links/empty state, attention & live lists incl. ticker advancing via real timers `flush(1100)`, spend switcher flips without network, workspace cards incl. paused/no-runs/danger marker, per-block error state), router tests for `/`→`/home` redirect and `/workspaces` list; **update existing** `app-sidebar.spec.ts` (new first nav item, changed `to`/active rules, removal of the `/`→`/human-queue` one-shot) and any test seeding `initialPath: '/'` expecting WorkspaceList.
- Existing fixtures in `test/handlers.ts` gain `sampleHomeSummary`, `sampleGlobalRuns`, `sampleHomeWorkspaces` + default handlers so unrelated whole-app tests don't 'error' on unhandled requests (msw is `onUnhandledRequest: 'error'`).

## R10. Things checked and ruled out

- **Human-task item lacks `ticket.summary`** (human-queue.schema.ts:34-61 — ticket is `{key, jira_url}|null`): the hero's second line uses the task `title` (already the human-readable ask) + agent + workspace + waiting age. Matches mock closely enough; NO backend change to human-tasks (keeps the spec's "no new backend for block 1" promise). The mock's per-row ticket-summary sub-line is directional fake data.
- **`GET /api/human-tasks/count`** is already global (human-tasks.controller.ts:133-140) — the summary endpoint still returns `human_open` itself so tiles stay atomic (FR-010); the sidebar badge keeps using the existing count query untouched.
- **Web has no runtime zod parsing** (responses cast via `as T` from contracts types) — new composables follow the same pattern; no new runtime-validation layer invented.
- **`update-agent-context` script does not exist** in `.specify/scripts/bash/` — the agent-context step of the plan workflow is N/A for this repo (CLAUDE.md is maintained manually; no edits needed for this feature).

# Tasks: Home Dashboard

**Input**: Design documents from `/specs/017-home-dashboard/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: REQUIRED in-iteration — the spec (FR-028) explicitly mandates contract tests, backend integration tests (vitest + testcontainers), and web component tests, even though this feature is not pipeline logic under constitution Principle VI.

**Organization**: Grouped by user story (US1..US6 from spec.md). US1 builds the page shell and routing that later stories render inside — see Dependencies.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1..US6 — user story phases only

## Path Conventions

pnpm monorepo: `packages/contracts/src/`, `apps/backend/src/dashboard/`, `apps/web/src/`, integration tests in `test/integration/`, web tests in `apps/web/test/` (per plan.md Project Structure).

---

## Phase 1: Setup

**Purpose**: The shared contracts module every story consumes.

- [ ] T001 Create `packages/contracts/src/home.schema.ts` with `HomeSummaryResponseSchema`, `HomeWorkspaceItemSchema` + `HomeWorkspacesResponseSchema`, `GlobalRunsQuerySchema` (required status CSV ⊆ `RunStatusSchema`, optional `finished_within` reusing `RunCostPeriodSchema`, `limit` default 10 clamp 1..50), `GlobalRunListItemSchema` + `GlobalRunsResponseSchema` (`{items,total}`), all `.strict()` snake_case with `z.infer` types per data-model.md; export from `packages/contracts/src/index.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contract tests + shared client plumbing + msw defaults that keep the whole web suite green once Home starts fetching. No user story starts before these.

- [ ] T002 [P] Contract tests in `packages/contracts/src/home.schema.spec.ts`: valid parses for all three response schemas; `GlobalRunsQuerySchema` rejects missing/empty/unknown status tokens, clamps `limit`, accepts/rejects `finished_within` values (style: `dashboard.schema.spec.ts` — safeParse + path-qualified issues)
- [ ] T003 [P] Web API fetchers: new `apps/web/src/api/home.ts` (`getHomeSummary()`, `getHomeWorkspaces()`) and add `getGlobalRuns(params)` to `apps/web/src/api/runs.ts`, typed from `@brigadir/contracts`, via the existing `apiClient`/`toQuery`
- [ ] T004 [P] msw fixtures + default handlers in `apps/web/test/handlers.ts`: `sampleHomeSummary`, `sampleGlobalRuns`, `sampleHomeWorkspaces` and default `http.get` handlers for `/api/home/summary`, `/api/home/workspaces`, `/api/runs` (msw runs `onUnhandledRequest:'error'` — whole-app specs must not break)

**Checkpoint**: `pnpm typecheck && pnpm test` green with new contracts — user stories can begin.

---

## Phase 3: User Story 1 — Land on Home and see what awaits me (Priority: P1) 🎯 MVP

**Goal**: `/home` exists and is the landing page; hero shows pending human tasks with links; sidebar gains Home; old links keep working.

**Independent Test**: With open human tasks seeded (msw or live), opening `/` lands on Home; hero shows count + oldest ≤5 tasks with working links; `/workspaces` serves the list; sidebar Home is first and active.

- [ ] T005 [US1] Routing in `apps/web/src/router/index.ts`: `/` → `redirect: '/home'`; new `/home` (name `home`) → lazy `views/HomeDashboard.vue`; move workspace list to `/workspaces` KEEPING route name `workspaces` (per contracts/web-routing-ui.md)
- [ ] T006 [US1] Remove the one-shot `/` → `/human-queue` auto-redirect in `apps/web/src/App.vue` (lines ~38-45) — superseded by the hero (research R6)
- [ ] T007 [P] [US1] Sidebar in `apps/web/src/components/AppSidebar.vue`: prepend Home item (lucide `House` in `<AnimatedIcon>`, `anim-trigger` link, `to:'/home'`, `isActive: path==='/home'`); update workspaces item `to:'/workspaces'`, `isActive: path==='/workspaces' || path.startsWith('/workspaces/')`
- [ ] T008 [US1] Page shell `apps/web/src/views/HomeDashboard.vue`: layout per mock hierarchy (tiles row → left hero+attention / right live+spend columns → workspace grid), scoped SCSS with `$space-*` tokens, block slots render placeholders until sibling stories land
- [ ] T009 [P] [US1] `apps/web/src/components/Home/HumanQueueHero.vue`: reuse `useHumanTasks('open', {page:1, page_size:5})`; count chip = response `total`; rows show `title`, ticket key (nullable), agent name, workspace name, `relativeAge(created_at)+' ago'`; row → `/runs/${run_id}` when present; header "Open queue →" → `/human-queue`; positive `el-empty` at zero; `data-test` hooks
- [ ] T010 [US1] Wire `HumanQueueHero` into `HomeDashboard.vue` hero slot (most prominent block styling per mock)
- [ ] T011 [P] [US1] Update `apps/web/test/app-sidebar.spec.ts` (+ any spec seeding `initialPath:'/'` expecting WorkspaceList): new first nav item, `/`→`/home` redirect, `/workspaces` list route, removed one-shot redirect
- [ ] T012 [P] [US1] Hero scenarios in new `apps/web/test/home-dashboard.spec.ts` (`mountWithProviders` + msw overrides): count+rows oldest-first, >5 tasks shows 5 + total, row/link navigation to run card and `/human-queue`, empty state

**Checkpoint**: US1 alone is a shippable landing page (spec's stated MVP).

---

## Phase 4: User Story 2 — Stat tiles (Priority: P2)

**Goal**: Four counters from one atomic `GET /api/home/summary` response (which also carries spend for US6).

**Independent Test**: Seed a known run/task mix against real Postgres → summary returns exact counters; tiles render them; 25h-old failure excluded.

- [ ] T013 [US2] Backend: new `apps/backend/src/dashboard/home.controller.ts` — `@Controller('api/home')` + `@UseGuards(DashboardTokenGuard)`, `@Get('summary')` per contracts/home-api.md: status counts, `attention_24h` split on `finished_at >= now()-24h`, `human_open`, spend via `SUM(cost_usd) FILTER`/`COUNT FILTER` on `created_at` windows for 24h/7d/30d (strings); register controller in `apps/backend/src/dashboard/dashboard.module.ts`
- [ ] T014 [P] [US2] Integration test `test/integration/home-summary.spec.ts` (mirror `runs-cost.spec.ts` harness): counters per status; 24h boundary exclusion; spend equals Σ per-workspace `runs/cost` per period (string-decimal compare); null-cost run counted, adds 0; all-zeros 200 on empty DB; 401 without token
- [ ] T015 [P] [US2] Composable `apps/web/src/composables/useHomeSummary.ts`: key `['home','summary']`, `refetchInterval: 5000`, `placeholderData: (prev)=>prev`
- [ ] T016 [US2] `apps/web/src/components/Home/StatTiles.vue` + wire into page: running (pulse-dot pattern from `RunStatusTag`), queued, failed-24h (`--el-color-danger*` when >0, sub-line "N failed · M timed out"), awaiting-human; all from one `useHomeSummary` result
- [ ] T017 [P] [US2] Tile scenarios in `apps/web/test/home-dashboard.spec.ts`: counter rendering, danger styling when >0, zero state, single-response atomicity (one msw call feeds all four)

---

## Phase 5: User Story 3 — Needs attention list (Priority: P2)

**Goal**: Cross-workspace failed/timed_out-in-24h list via the new bounded `GET /api/runs`.

**Independent Test**: Failed/timed_out runs across 2 workspaces (some >24h old) → only last-24h returned newest-finished-first; 422 without status; rows link to run cards.

- [ ] T018 [US3] Backend: `@Get('api/runs')` in `apps/backend/src/dashboard/runs.controller.ts` per contracts/runs-global-api.md — required status CSV validated against `RunStatusSchema` (422 via `dashboard.errors.ts`), optional `finished_within`, limit clamp 1..50, LEFT JOIN tickets / INNER JOIN agents / INNER JOIN workspaces, `deep_link` from workspace `jira_site_url`, composite CASE `ORDER BY` (running `started_at ASC NULLS LAST` → queued `created_at ASC` → terminal `finished_at DESC NULLS LAST` → `id`), `{items, total}` with full-count total
- [ ] T019 [P] [US3] Integration test `test/integration/runs-global.spec.ts`: 422 on missing/empty/unknown status; limit default 10 + clamp 50; full ordering rule across a mixed seed; `finished_within=24h` boundary; ticketless setup run listed `ticket:null`; `total` vs `items.length`; cross-workspace mixing; 401
- [ ] T020 [P] [US3] Composable `apps/web/src/composables/useGlobalRuns.ts`: key `['runs','global',params]`, 5000 interval, `placeholderData`
- [ ] T021 [US3] `apps/web/src/components/Home/NeedsAttentionList.vue` + wire: `useGlobalRuns({status:'failed,timed_out', finished_within:'24h', limit:10})`; rows `RunStatusTag` + ticket key/summary + agent + workspace + `relativeAge(finished_at)`; row → `/runs/:id`; header count chip + "All runs →" link; positive empty state
- [ ] T022 [P] [US3] List scenarios in `apps/web/test/home-dashboard.spec.ts`: rows + fields, links, empty positive state, "view all" visible when `total > items.length`

---

## Phase 6: User Story 4 — Live runs list (Priority: P3)

**Goal**: Running+queued across workspaces with a 1-second ticker on running rows.

**Independent Test**: Running + queued seed → one list ordered running-first; tickers advance without network; finished runs leave on next poll.

- [ ] T023 [US4] `apps/web/src/components/Home/LiveRunsList.vue` + wire: `useGlobalRuns({status:'running,queued', limit:10})` (server ordering trusted, no client sort); running rows `RunStatusTag` pulse + `formatDuration(Math.max(0, now − Date.parse(started_at)))` via `useNow()` (Runs.vue:57-63 pattern); queued rows waiting age from `created_at`; rows → `/runs/:id`; idle empty state; "view all" link when `total > items.length`
- [ ] T024 [P] [US4] Live scenarios in `apps/web/test/home-dashboard.spec.ts`: ticker advances with real timers (`flush(1100)` pattern from `runs-table.spec.ts`), clamp-at-zero for future `started_at`, queued age rendering, run leaving the list after msw handler swap + refetch

---

## Phase 7: User Story 5 — Workspace cards grid (Priority: P3)

**Goal**: All workspaces as health cards from one batched `GET /api/home/workspaces`.

**Independent Test**: 3 workspaces (paused / 24h-failure / runless) → one request returns correct aggregates; cards render variants and navigate.

- [ ] T025 [US5] Backend: `@Get('workspaces')` in `apps/backend/src/dashboard/home.controller.ts` per contracts/home-api.md — ≤4 batched queries (workspaces `created_at ASC`; agent counts GROUP BY; last runs `DISTINCT ON (workspace_id) … ORDER BY workspace_id, created_at DESC`; attention counts GROUP BY on `finished_at >= now()-24h`) merged in memory; `enabled` from `settings.enabled !== false`; `{items}` no pagination
- [ ] T026 [P] [US5] Integration test `test/integration/home-workspaces.spec.ts`: per-workspace `agent_count`/`last_run`/`attention_24h`; paused workspace `enabled:false`; runless workspace `last_run:null`; empty platform `{items:[]}`; ordering `created_at ASC`; 401
- [ ] T027 [P] [US5] Composable `apps/web/src/composables/useHomeWorkspaces.ts`: key `['home','workspaces']`, `refetchInterval: 15000`, `placeholderData`
- [ ] T028 [US5] `apps/web/src/components/Home/WorkspaceCardsGrid.vue` + wire: card = name, `project_key` chip, active/paused `el-tag` (paused card muted), `agent_count`, last run (`RunStatusTag` + relative time | "no runs yet"), danger marker "N failed in last 24h" vs calm note; card → `{name:'runs', params:{id}}`; zero-workspaces empty-state guidance; "All workspaces →" → `/workspaces`
- [ ] T029 [P] [US5] Card scenarios in `apps/web/test/home-dashboard.spec.ts`: variant rendering (paused/danger/runless), navigation on click, grid from single request

---

## Phase 8: User Story 6 — Platform spend (Priority: P3)

**Goal**: Platform-wide totals for 24h/7d/30d with an instant client-side switcher (data already in US2's summary).

**Independent Test**: Summary fixture with three period figures → default 24h shown; switching flips figures with NO new request; zero renders `$0.00`.

- [ ] T030 [US6] `apps/web/src/components/Home/SpendCard.vue` + wire: consumes `useHomeSummary().spend`; `el-radio-group` switcher (`24h` default, pattern Runs.vue:75-79) over local `ref<RunCostPeriod>`; figure via `formatCostUsd`, sub-line `run_count`; zero → `$0.00` not empty
- [ ] T031 [P] [US6] Spend scenarios in `apps/web/test/home-dashboard.spec.ts`: default period, switch without network (assert msw call count unchanged), zero state, figures match fixture per period

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T032 [P] Guard coverage: extend `test/integration/dashboard-auth.spec.ts` with the three new routes (`/api/home/summary`, `/api/home/workspaces`, `/api/runs?status=running`) → 401 without/with bad token
- [ ] T033 Per-block error degradation (FR-024): each Home block renders an in-block error note from its own query `isError` while siblings keep rendering; component test scenario in `apps/web/test/home-dashboard.spec.ts` (one endpoint 500s, others render)
- [ ] T034 Consistency invariants test (SC-004, contracts/home-api.md): in `test/integration/home-summary.spec.ts` (or dedicated block) assert summary counters equal `GET /api/runs` totals for matching filters and `human_open` equals `/api/human-tasks/count` on the same seed
- [ ] T035 Full verification per quickstart.md: `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:integration`, manual walkthrough of quickstart §3 against compose stack; fix fallout
- [ ] T036 Append the iteration entry to `docs/progress.md` (per project convention: journal updated each iteration)

---

## Dependencies

```text
Phase 1 (T001) ─→ Phase 2 (T002–T004) ─→ all user stories
US1 (T005–T012): independent of backend work — MVP; T008 (shell) blocks every later block's wiring task
US2 (T013–T017): needs T001; UI wiring (T016) needs T008
US3 (T018–T022): needs T001; UI wiring (T021) needs T008
US4 (T023–T024): needs T018+T020 from US3 (same endpoint/composable) and T008
US5 (T025–T029): needs T001; UI wiring (T028) needs T008
US6 (T030–T031): needs T013+T015 from US2 (spend rides the summary) and T008
Polish (T032–T036): after the stories they touch; T035/T036 last
```

Story completion order: **US1 → US2 → US3 → US4 → US5 → US6** (priority order; US4 must follow US3, US6 must follow US2 — both reuse the earlier story's endpoint).

## Parallel Execution Examples

- After T001: T002, T003, T004 in parallel (three different files).
- Within US1: T007 (sidebar) ∥ T009 (hero component) while T005→T006→T008 proceed; then T011 ∥ T012.
- Backend endpoints T013 (summary), T018 (global runs), T025 (home workspaces) touch different controller scopes: T013 ∥ T018 fully; T025 shares `home.controller.ts` with T013 — sequence after it.
- Each story's integration test (T014/T019/T026) ∥ its composable (T015/T020/T027) — different files.
- US3's backend (T018–T020) can run in parallel with US2's UI (T016–T017).

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + US1** — a working landing page with the human-queue hero and the routing change, zero new backend. Ship/checkpoint there, then add stories in priority order; each phase leaves the page coherent (unwired blocks are absent, not broken). Suggested increments: (1) US1; (2) US2+US6 backend-light pair (one endpoint powers both); (3) US3+US4 pair (one endpoint powers both); (4) US5; (5) polish sweep T032–T036.

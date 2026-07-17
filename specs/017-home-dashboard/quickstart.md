# Quickstart — Feature 017: Home Dashboard (validation guide)

How to prove the feature works end-to-end. Contracts: [contracts/](contracts/), shapes:
[data-model.md](data-model.md).

## Prerequisites

- Node 22 + pnpm, Docker running (testcontainers + compose).
- `.env` per `docs/local-setup.md` (`BRIGADIR_DASHBOARD_TOKEN` set).

## 1. Static + unit + contract

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expect new passing specs: `packages/contracts/src/home.schema.spec.ts` (summary/global-runs/
home-workspaces schemas: valid parse, status-CSV rejection, limit clamp) plus existing suites
green (notably `apps/web/test/app-sidebar.spec.ts` updated for the new routing).

## 2. Backend integration (real Postgres/Redis via testcontainers)

```bash
pnpm test:integration
```

New suites to expect green:

- `test/integration/home-summary.spec.ts` — counters per status; 25h-old failure excluded;
  spend equals Σ per-workspace `runs/cost` for each period; zero-state all-zeros 200; 401
  without token.
- `test/integration/runs-global.spec.ts` — 422 on missing/unknown `status`; limit default 10 /
  clamp at 50; ordering rule (running oldest-first → queued oldest-first → terminal
  newest-finished-first, id tie-break); `finished_within=24h` boundary; ticketless setup run
  listed with `ticket: null`; `total` = full match count.
- `test/integration/home-workspaces.spec.ts` — agent_count / last_run / attention_24h per
  workspace; paused workspace `enabled: false`; runless workspace `last_run: null`; single
  request returns all workspaces.

## 3. Web app, live

```bash
docker compose up --build          # or dev mode per docs/local-setup.md
pnpm --filter web dev              # http://localhost:5173
```

Walkthrough (mirrors spec acceptance scenarios):

1. Open `/` → redirected to `/home`; sidebar shows Home as FIRST item, active.
2. Seed activity (run agents or insert rows in dev DB): tiles show running/queued/failed-24h/
   awaiting-human counts matching `/human-queue` and runs pages.
3. Hero: oldest ≤5 open tasks, waiting ages; row click lands on the run card; "Open queue →"
   lands on `/human-queue`; with zero tasks a positive empty state renders.
4. Live runs: running rows tick every second without network requests (watch devtools);
   queued rows show waiting age; a finishing run leaves the list within ~5 s.
5. Needs attention: only last-24h failed/timed_out, newest first, links to run cards.
6. Spend: switching 24h/7d/30d flips the figure with NO new request; totals match the
   per-workspace Runs-tab figures summed.
7. Workspace grid: each card name/board/paused-state/agent-count/last-run; danger marker on
   workspaces with 24h failures; card click opens the workspace; `/workspaces` still lists
   workspaces (old `/` bookmarks redirect).
8. Kill the backend briefly: each block shows its own error state; page shell + other cached
   blocks stay rendered; recovery on next poll.

## 4. Component tests only

```bash
pnpm --filter web test
```

Expect `apps/web/test/home-dashboard.spec.ts` (+ updated `app-sidebar.spec.ts`) green — tiles,
hero links/empty, ticker advance via real timers, spend switcher without refetch, per-block
error degradation, workspace card variants.

## Success = spec SC-001..SC-007

One screen answers all four questions; every row links to an existing detail page in one
click; counters consistent with the pages they summarize; `/` and old links unbroken; all new
behavior covered by the tests above in the same iteration.

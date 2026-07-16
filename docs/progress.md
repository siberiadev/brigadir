# BRIGADIR — Progress Journal

## Iteration 1 — Pipeline Skeleton (Monorepo, Database, Queues, Mock Executor)

- **Status**: ✅ Complete — MVP (US1) reached; DoD gate passed.
- **Date**: 2026-07-10
- **Spec**: `specs/001-pipeline-skeleton/`
- **Branch**: `001-pipeline-skeleton`

### What shipped

A pnpm/NestJS monorepo with two entrypoints (`apps/backend`, `apps/worker`) plus
a one-shot `apps/smoke` trigger helper, the full Postgres 16 schema (9 tables)
via Drizzle with committed SQL migrations, BullMQ 5 queues (`run.mock` +
`reconcile`), fail-fast zod-validated `agents.yaml` loading + idempotent DB seed,
a deterministic six-scenario MockExecutor behind the `AgentExecutor` contract,
the guarded run state machine, and docker-compose for the four-service stack.
Framework-free `packages/contracts` (zod only) holds every schema.

### Definition-of-Done checklist

- [x] **All integration tests green** — `pnpm test:integration`: 10 files / 24
      tests pass (six-scenario lifecycle, dedup sequential+concurrent, rate-limit
      accounting, config-validation matrix, finalize idempotency, scheduler
      idempotency, `runs_one_active` race, health). Unit: `pnpm test` 27 pass.
- [x] **Static checks green** — `pnpm typecheck` and `pnpm lint` clean.
- [x] **Migrations apply from scratch** — every integration suite boots a fresh
      Postgres 16 container and applies the committed `drizzle/` SQL from zero;
      `docker compose up` from empty volumes does the same on backend boot.
- [x] **Compose boots 4 services** — `docker compose up --build` from empty
      volumes → `postgres` healthy, `redis` healthy, `backend` healthy
      (migrations + seed of workspace "BRIG" with 1 executor / 1 agent, then
      `GET /health` → `{status:'ok',db:'up',redis:'up'}`), `worker` up
      (reconcile scheduler upserted, consuming `run.mock`).
- [x] **Manual smoke** — `smoke:run --scenario success` → `succeeded/attempt 1`;
      `--scenario crash` → `failed/attempt 2` (retried once then failed).
- [x] **Config fail-fast** — a broken `agents.yaml` aborts boot with exit 1 and
      a stderr message naming the file and the offending field path.
- [x] **Restart isolation (SC-007)** — `docker compose restart backend` leaves
      the worker Up with no disconnect/reconnect churn in its logs.
- [x] **README ≤ 15 min** — `README.md` walks install → tests → compose for a
      newcomer.

### Environment note (not a defect)

On the dev machine used for the DoD run, `curl localhost:3000/health` returned a
404 from an **unrelated pre-existing app** (ST3 OS, `st3_os/dist/src/main`)
already bound to loopback `:3000`; `localhost:5432` was likewise a different
Postgres. The compose backend itself is correct: its in-container healthcheck
returns `{status:'ok',db:'up',redis:'up'}`, and host access via the LAN IP
(`http://<host-ip>:3000/health`) returns the same. Manual smoke was therefore
run inside the container network (where `DATABASE_URL` targets the `postgres`
service). No code change required.

### Flagged deviations from the architecture docs (intentional — do NOT "fix")

- **F1 — `mock` executor type**: architecture §4 enumerates four real executor
  types (`claude_cli | anthropic_api | deepseek_api | claude_routines`); NFR
  item 5 mandates a mock. The `AgentExecutor.type` union and the `agents.yaml`
  executor schema gain a `mock` member so the mock flows through the real
  registry/queue/config path. The four real types stay reserved.
- **F2 — `needs_human` without Jira**: architecture §2 pairs
  `outcome=needs_human` with a Jira transition to Blocked + ADF comment.
  Iteration 1 performs only the Postgres half (run → `awaiting_human`, one open
  `human_tasks` row). The Jira half is iteration-2 scope; the `onRunFinished`
  seam is prepared.
- **F3 — reconcile is a no-op stub**: architecture §4 gives the sweeper three
  duties (poll Jira, repair run↔queue drift, webhook refresh). Iteration 1
  registers the scheduler (`upsertJobScheduler('reconcile', {every: 300_000})`,
  proven idempotent) and an empty log-only handler. Duties need Jira + real
  executors (iteration 2).

No other deviations: schema §3 implemented as-is (reviewed in
`drizzle/REVIEW-0000_init.md`), the exitStatus→status mapping follows §4, and the
BullMQ worker settings follow spec §0.5 verbatim.

### Post-DoD fix (2026-07-11): integration-test flake root-caused

Full-suite runs flaked ~50% (jobs "stuck at queued/running" for 60–150 s in the
last two suites) while every suite passed in isolation. Root cause: **the queue
Redis connection was resolved at module IMPORT time** — `QueuesModule.register()`
runs inside the `@Module` decorator, so `buildRedisConnection()` read `REDIS_URL`
before test `beforeAll` (or any late env) set it and silently fell back to
`localhost:6379`, a host-installed redis-server. Every suite of every run shared
that one Redis: stale jobs from dead runs accumulated (142 keys found) and
workers burned their 2 concurrency slots retrying foreign jobs whose runIds
lived in long-gone test databases — hence mid-suite stalls that "self-healed".

Fixes:
- `QueuesModule`: `BullModule.forRoot` → **`forRootAsync`** so the connection is
  built at Nest context init (env honored). Queue *names* stay composition-time
  by design (documented in the module).
- `buildRedisConnection()` now honors the **logical DB index** from the URL path
  (`redis://host:port/2`) — previously dropped.
- Test infra: one shared Postgres + one shared Redis container per run
  (`test/integration/global-setup.ts`); per-suite isolation is logical — a fresh
  `CREATE DATABASE` and a flushed Redis logical DB per suite (harness.ts).
  Worker-booting suites gate on `worker.waitUntilReady()` before polling.

Verified: 3 consecutive full runs green (24/24), host redis no longer touched
by tests. Lesson recorded: anything read inside a `@Module` decorator argument
executes at import — connections must always be resolved in factories.

### Build/runtime note

Apps are built with NestJS's webpack bundler (`nest-cli.json` `webpack: true`)
so each entrypoint emits a single runnable `dist/apps/<app>/main.*.js` with the
`@brigadir/*` path aliases inlined; `packages/contracts` stays external and
resolves via its workspace package. Vitest emits decorator metadata via
`unplugin-swc` so NestJS type-based DI resolves in tests as it does at runtime.

## Iteration 6 — Runs Visibility & Human Queue (feature 006)

The operational half of the dashboard. Closes product pains #2 (unreadable
reports) and #3 (no needs-human queue), and pays down iteration-5 debt
(executors admin, multi-workspace reconcile).

### What shipped

**Backend/worker (Session 1)** — executors CRUD under
`/api/workspaces/:id/executors` (typed per-type config union, default seeding on
workspace create, `OnApplicationBootstrap` type-scoped backfill, delete-guard →
409 `executor_in_use`); live concurrency re-apply on a ~15 s worker timer;
multi-workspace reconcile (every `settings.enabled != false` workspace, per-
workspace Jira client resolved lazily in `forWorkspace`, per-workspace try/catch
outage isolation); runs read surface (`/api/workspaces/:id/runs` list + cost,
`/api/runs/:id` card, guarded `cancel` `WHERE status='running'`, `retry` via
manual-trigger through all three idempotency layers); global human-queue
list/count; the feature-004 resolve endpoint moved behind `DashboardTokenGuard`.

**Frontend (Session 2)** — four operator surfaces, all live via TanStack Query
`refetchInterval` polling (no SSE, no bearer in any URL): the needs-human queue
(resume / done_manually / dismiss + history) with a live navbar open-task badge
and the `open > 0` landing rule; the run/ticket card (✅/❌/⚠/⏭ report checklist
with expandable reasons, event timeline, run history, failure diagnostics,
cancel/retry); the workspace runs table (agent/status/ticket filters,
pagination, cost header with 24h/7d/30d presets, row → card); executors admin in
Workspace Settings (typed `ExecutorForm` modal driven by the shared
`executor.schema` union, list/create/update/delete with the in-use 409
surfaced) plus the enabled/pause Start/Pause control and a Running/Paused status
column in the workspace list. The agent form's executor picker now reads the
real `/executors` (names + type badge, defaults to the workspace's `claude_cli`
executor, never a raw UUID). Component tests are msw + `@vue/test-utils` extending
`apps/web/test/{mount,handlers}.ts` — no live backend needed.

### No structural schema change (two additive items only)

1. One additive index `runs_workspace_created` on `(workspace_id, created_at
   desc)` — committed migration + reviewed SQL (constitution rule #5).
2. The enabled/pause flag lives in `workspaces.settings` jsonb
   (`settings.enabled`; absent ⇒ enabled) — no DDL. Session 2 extended the
   shared `WorkspaceSettingsRequestSchema` with an optional `enabled` (the write
   path, which flows through `patchWorkspaceSettings`) and added `enabled` to
   `WorkspaceResponse` (mapped in the backend `toResponse` from settings) so the
   Start/Pause control reflects and writes the persisted state.

### Live pass

Checkpoint (2026-07-13, live dev stack): token gate → workspaces landing;
Runs tab filters/cost header/empty state; executors admin lists the live
workspace's custom-named executors (type-scoped backfill is a no-op — no
duplicate defaults); the executor edit form round-trips typed config; **live
concurrency re-apply proven on the running worker** (`concurrency_limit` 1→2
via the UI → worker log `run.claude_cli concurrency: 2 (was 1)` within one
15 s tick, no restart → reverted); agent-form executor picker defaults to the
claude_cli executor by NAME (no UUIDs, never empty); human queue renders with
its empty state; unauthenticated API calls → 401. Checkpoint fix landed the
same day: PipelineService / HumanTaskService / ResumeService moved off the
global LIMIT-1 Jira client onto per-workspace `forWorkspace` resolution (the
write-path half of multi-workspace, missed by the 006 spec's US5 scope).

**Deferred to iteration 11 step 0 (decision 2026-07-13; renumbered from 10 when
iteration 10 "Platform Settings + глобальные executors" was inserted)**: the write-path live
scenarios — agent-via-UI + mock test-run with a real Jira transition/comment
(gates T158/T070), the first live `claude_cli` run (T091), and the callback
run request_human → queue → resume (T117) — plus journal gate entries
T071/T092/T118/T159 and the T055 checkbox. They need a sacrificial board
ticket and run at the start of the migration iteration, where live agent runs
happen anyway. All static gates (`pnpm typecheck && pnpm lint && pnpm test`,
the web package's `vue-tsc`, 38 msw component tests, 181 integration) green.

## Iteration 7 — Workspace Tabs Navigation (feature 007)

### What shipped

Frontend-only rework of the workspace-level navigation in `apps/web`. A
workspace is now a **page with two router-driven tabs — Agents | Runs** rather
than two per-row action buttons. Clicking a workspace **row** in `WorkspaceList`
opens that workspace on the Agents tab; a shared, reusable `WorkspaceTabs`
component (`components/WorkspaceTabs/`) switches the body below by pushing a
named route, so the **URL is the single source of truth for the active tab** —
active state is a `computed` over `useRoute().name`, there is no local
active-tab ref (FR-008).

`/workspaces/:id` became a parent route rendering the new `WorkspacePage`
(`<WorkspaceTabs>` + `<router-view>`), with children `agents`/`runs` kept at the
**verbatim** shipped paths `/workspaces/:id/agents` and `/workspaces/:id/runs`
(FR-009 — every existing deep-link from run cards / human queue / navbar
resolves unchanged), an empty-path redirect to Agents (default tab, FR-006), and
a nested `:catchAll(.*)*` redirect for unknown tabs → Agents (FR-012).
`AgentsList.vue` and `Runs.vue` are reused **as-is** as the two tab bodies — zero
changes inside them (FR-011).

`WorkspaceList` lost the Agents/Runs `RouterLink` buttons (FR-001) and gained an
`@row-click` that navigates to the workspace (FR-003); the retained Settings and
Start/Pause row actions carry `@click.stop` so a row action never also triggers
row navigation (FR-004). Settings now **navigates to the `workspace-settings`
page** (its own top-level route) instead of opening the inline dialog — the
orphaned settings `FormDialog` and its state were removed. (This is the one
deliberate departure from the spec's "Settings opens the dialog as before"
wording: the accepted iteration-7 decision routes Settings to the settings
page; the tab test asserts the route becomes `workspace-settings`.)

### Route precedence guard (research R1)

The top-level static `/workspaces/:id/settings` (`workspace-settings`) must
out-rank the nested `:catchAll` redirect so `/settings` is not swallowed. A
component test asserts `router.resolve('/workspaces/:id/settings').name ===
'workspace-settings'` against the **real** exported routes, so a future route
reorder can't silently regress it.

### Tests

New `apps/web/test/workspace-tabs.spec.ts` (10 cases) drives the app's **real**
routes through the memory-history harness: tab switch Agents⇄Runs with
URL-reflected active tab, row-click navigation, both shipped deep-links,
back/forward across tabs, unknown-tab→Agents fallback, settings precedence, no
Agents/Runs buttons on rows, and that Start/Pause and Settings row actions
don't wrongly navigate. `test/mount.ts` gained optional `routes`/`initialPath`
(memory router seeded before install so vue-router's install navigation targets
`initialPath`); the change is additive — the ~12 existing specs pass no `routes`
and keep the single catch-all stub. Element Plus `el-tabs`/`el-table` events are
driven via `$emit` (the jsdom-safe convention the 006 runs-table spec already
uses).

All gates green: `pnpm --filter @brigadir/web typecheck` (vue-tsc strict) and
the 48 web msw component tests (38 pre-existing + 10 new). `apps/web/**` is
ESLint-ignored by the Nest-oriented root config (covered by vue-tsc). `git diff`
confined to `apps/web/` + `specs/007-workspace-tabs-navigation/` — no
`packages/contracts`, backend, worker, or `drizzle/` changes (FR-014, SC-006).

## Iteration 8 — Workspace Settings Tab (feature 008)

### What shipped

A third router-driven tab **Settings** (after **Agents | Runs**) on the
workspace page. The tab renders the workspace configuration as **read-only
`el-descriptions` blocks** — not forms with disabled fields — in three sections:
a **Jira connection** block (site, project, board, bot email, token expiry,
credential badge), a **configuration** block (default branch prefix, advanced
scope filter, repositories with the first tagged **Default**), and the existing
**executors** admin section (table + create/edit/delete modals, kept verbatim,
FR-009). Each editable block carries an **Edit** button that opens the
corresponding form body inside the shared `FormDialog`; the modals **seed from
the persisted `WorkspaceResponse`** and, on save, close and let vue-query
invalidation refresh the blocks in place (FR-007). Cancel/close sends no request
(FR-008). Every nullable value degrades to a placeholder — "Not configured" /
"No expiry" / em-dash / "No repositories configured", no phantom default marker
(FR-015).

The standalone settings page is **retired**: `/workspaces/:id/settings` is now a
nested `settings` tab child of `WorkspacePage`, declared **before** the
`:catchAll` redirect so the shipped deep-link resolves to the tab and is not
swallowed by the unknown-tab fallback. The list's Settings action and the
`WorkspaceList` row action now push `{ name: 'settings' }`; the top-level
`workspace-settings` route is gone (the iteration-7 precedence guard test was
updated to assert the deep-link resolves to `settings`).

The inline forms from the old `WorkspaceSettings.vue` were extracted into two
dialog-agnostic bodies mirroring `ExecutorForm` — `ConnectionForm`
(reconnect/re-verify, seeded from `bot_email`, keeps the working connection on a
re-verify failure) and `ConfigForm` (branch prefix / scope JQL / repositories,
seeded from persisted values). Both `defineExpose({ submit, saving })` and emit
`saved`; the hosting `FormDialog` footer drives `submit()`.

### The two defects fixed alongside

1. **Settings seeded from hard-coded defaults** (FR-014). The old standalone form
   seeded `branch_prefix`/`scope_jql` from `feat`/`""` because `GET /api/workspaces`
   never serialized them, so re-saving could silently overwrite a customized
   prefix. The **single additive, non-breaking** contract change adds
   `bot_email` / `branch_prefix` / `scope_jql` (all **nullable**) to
   `WorkspaceResponse` (`.strict()` kept). `toResponse` maps `branch_prefix` /
   `scope_jql` from the `settings` jsonb and `bot_email` from the decoded
   credential **email only** (`api_token` discarded, never serialized —
   Principle V). Decode is **fail-safe**: `decodeJiraCredentials` throws on a
   corrupt/placeholder blob (seen live in iteration 5), so it is wrapped in
   try/catch → `bot_email: null`; one bad row can never 500 the list/detail.
   A contract test asserts the three fields present and `api_token` absent; three
   integration cases assert the decoded email, the nullable/legacy degradation,
   and the corrupt-blob 200 fail-safe.
2. **FormDialog reopen race** (FR-013). Reopening a `FormDialog` while the prior
   instance's close transition was still running rendered an empty title+footer
   shell. Fixed with `destroy-on-close` on the inner `el-dialog` so the slotted
   body fully unmounts on close and re-mounts fresh on each open; all dismissal
   rules preserved (no close on outside click; close only via X / ESC / footer).
   Benefits all three edit modals + the create-workspace modal. A regression test
   opens → closes → reopens within the close window and asserts the body fields
   are present.

### Tests

`apps/web/test/workspace-settings.spec.ts` was rewritten (10 cases): read-only
blocks with no editable inputs + default-repo tag + FR-015 placeholders (US1);
both Edit-modal round-trips seeded from persisted values — the config seed
assertion verifies the value equals the **stored** prefix, not `feat` (US2); the
`/settings` deep-link resolving to route `settings` with the tab content, no
`workspace-settings` route remaining, and the unknown-tab→agents fallback (US3);
and the FormDialog reopen-race regression (US4). Modal content is queried on
`document.body` (Element Plus dialogs teleport via `append-to-body`). A nullable
workspace fixture was added to `test/handlers.ts`. The three additive fields got
a `packages/contracts` schema test and three `test/integration` response-mapping
cases.

All gates green: `pnpm typecheck` (+ `pnpm --filter @brigadir/web typecheck`),
`pnpm lint`, `pnpm test` (contracts 57, unit 190), the 53 web component tests,
and `pnpm test:integration` (60 files / 184 tests — re-run because `toResponse`
changed). The only backend/contract change is the additive `WorkspaceResponse`
extension + its `toResponse` mapping; no DB migration, no run/callback pipeline
change, no new endpoint (SC-005).

## Iteration 9 — Icon Sidebar Navigation (feature 009)

### What shipped

The top navigation **header** in `App.vue` is replaced by a fixed, ~70px-wide
left **icon rail** (`components/AppSidebar.vue`). Top to bottom it renders: a
compact wordless "B" brand mark, icon-only nav items (Workspaces → `LayoutGrid`,
Human queue → `Inbox`) each wrapped in a right-placed `el-tooltip`, and a
bottom-pinned Sign out (`LogOut`) icon. Icons come from the one new frontend
dependency, **`lucide-vue-next`** (the iteration-9-sanctioned package), imported
by tree-shakable named imports (`LayoutGrid`/`Inbox`/`LogOut`) — no global
registration in `main.ts`.

`AppSidebar` is deliberately **pure presentational**: it takes `openCount:
number` as a prop and emits `sign-out` — no store access and no count query
inside. `App.vue` stays the shell that owns everything stateful: the
`useHumanTaskCount` query, the `authed` gate, `openCount`, and the **006 landing
`watch` are retained verbatim** (FR-014). The badge that used to sit on the
header text link now rides the Human queue icon as an `el-badge` with
`:value="openCount"`, `:max="99"`, `:hidden="openCount === 0"`, `type="danger"`
— same cap/hidden-at-zero behavior, migrated not rewritten. Workspaces carries
no badge.

**Layout**: the rail is `position: fixed` left, full viewport height; the
authenticated main region is offset by `margin-left: 70px` so nothing renders
under the rail (SC-006). The **pre-auth token gate stays full-screen with no
sidebar** — `AppSidebar` lives only in the authenticated `v-else` branch; the
`v-if="!auth.token"` gate is untouched and rail-free (FR-013). Sign out flows up
as an emit and `App.vue` handles `@sign-out="auth.clear()"`, dropping back to the
gate.

**Active state** derives from the live route path inside the sidebar: Workspaces
is active on `/` **or** `/workspaces/*` (a prefix test covers the 007
agents/runs/settings deep sub-routes without enumerating child names); Human
queue on `/human-queue`; any other path (e.g. the run card `/runs/:id`)
highlights **nothing** (FR-006/FR-007). The marker is a consistent `is-active`
class on both nav items.

### Tests

New `apps/web/test/app-sidebar.spec.ts` (14 cases) drives the app's **real**
routes through the memory-history harness. It mounts `App.vue` (the shell,
seeding a token so the rail renders and pinning the count endpoint to `open: 0`
so the 006 landing watch never redirects `/` mid-test) for the shell cases, and
mounts the presentational `AppSidebar` directly with an `openCount` prop for the
badge cases:

- **Rendering + tooltips (US1)** — rail with brand + both nav icons + sign out,
  no top header (`.app-nav`/`ElHeader` gone); each icon in a `placement="right"`
  tooltip named exactly "Workspaces" / "Human queue" / "Sign out" (asserted on
  the `ElTooltip` `content`/`placement` props, no real hover).
- **Active highlight (US2)** — `is-active` on Workspaces at `/`,
  `/workspaces/ws-1/agents`, `/workspaces/ws-1/settings`; on Human queue at
  `/human-queue`; NEITHER at `/runs/r-1`.
- **Badge (US2)** — value shown at `openCount > 0`, `99+` cap for a large value,
  no visible badge at `0`, badge only on Human queue, and update-on-prop-change.
- **Sign out (US3)** — `trigger('click')` on the rail control clears the token,
  shows the full-screen gate, and leaves `app-sidebar` absent.
- **Pre-auth gate (US4)** — no token → full-screen gate, no rail; entering a
  token re-renders the shell and the rail appears.

### Gates

Frontend-only (FR-015): the diff is confined to `apps/web/src/App.vue`,
`apps/web/src/components/AppSidebar.vue`, `apps/web/package.json`,
`apps/web/test/app-sidebar.spec.ts` (+ the `pnpm-lock.yaml` entry for
`lucide-vue-next`) — no backend, contract, schema, or endpoint change. All
authoritative gates green: `pnpm --filter @brigadir/web typecheck` (strict
props/events), `pnpm --filter @brigadir/web test` (67 web component tests, the
14 new alongside the existing 53), and root `pnpm lint`.

## Iteration 10 — Platform Settings + Global Executors (done outside spec-kit, decision 2026-07-13)

> Session 2 (2026-07-14) reshaped this same unmerged iteration into NAMED
> RUNNER PROFILES — see the addendum at the end of this entry.

### What shipped

Executors moved from workspace scope to **platform scope**, retrospectively
fixing the model: an executor is PHYSICAL capacity (the `claude` CLI on the
host, a subscription or API key), and the system already treated it that way —
one `run.<type>` BullMQ queue per type for the whole platform, and the worker's
`applyExecutorConcurrency` summing `concurrency_limit` per type across all
workspaces. The workspace scoping was inherited from the agents.yaml era and
the config knob lied about its scope; this iteration makes the model honest.

- **Schema (migration 0003 + `REVIEW-0003_platform_executors.md` + architecture
  §3)**: `executors.workspace_id` (FK column) dropped; `executors_workspace_name`
  replaced by a GLOBAL `UNIQUE(name)` (`executors_name`). Defensive dedupe:
  colliding names are suffixed with an id fragment (row ids never change, so
  `agents.executor_id` needs no rewrite; zero rows touched on the live DB).
  Existing rows are kept; a leftover `repository` key in `config` is ignored.
- **`repository` moved to the AGENT**: run-time resolution for `claude_cli` is
  `agents.behavior.repository` (new OPTIONAL key in the existing behavior
  jsonb — no agents DDL) → else the run workspace's default repository (first
  `settings.repositories` entry; legacy yaml fallback kept). Stripped from the
  executor typed config (`executor.schema.ts`), the ExecutorForm, and seeding.
- **API**: workspace-scoped `/api/workspaces/:id/executors` replaced by global
  `/api/executors` (GET/POST/PUT/DELETE, same bearer guard, same typed per-type
  validation, global name-conflict 409, delete-guard 409 `executor_in_use`
  counting referencing agents across ALL workspaces, secrets never serialized).
  Workspace creation no longer seeds executors; one global TYPE-scoped backfill
  at backend bootstrap inserts a type's default only when no executor of that
  type exists at all (`claude` claude_cli / `mock` mock, both concurrency 2).
- **UI**: new platform **Settings** surface — lucide `Settings` gear in the
  70px rail (above Sign out, tooltip "Settings", active for `/settings/*`);
  `/settings` → `/settings/executors`; the page has its own left sub-navigation
  (single "Executors" item now, trivially extensible to General/Users/Usage).
  The Executors section is REMOVED from the workspace Settings tab (Jira
  connection + Configuration remain). AgentForm gained an optional Repository
  select (workspace repositories + explicit "workspace default" empty option,
  persisted into `behavior.repository`); its executor picker now lists the
  global executors.

### Tests

Integration (testcontainers + mock-jira): global executors CRUD + name-conflict
+ cross-workspace delete guard + global type-scoped backfill + migration 0003
(from scratch via the harness chain AND stepwise 0000–0002 with pre-seeded
multi-workspace data, asserting kept rows/stable ids/dedup-suffix) + claude_cli
repository resolution (behavior wins → workspace default → clear error when
both missing). Web (msw): settings page + sub-nav, gear icon active state +
tooltip, executor form without repository, agent form repository select +
global executor picker; existing executor-scoped fixtures/specs updated for the
new endpoint shapes.

### Addendum (session 2, 2026-07-14) — named runner profiles

The same unmerged branch/migration reshaped executors into **named runtime
profiles**: transport type (code registry — rows cannot create behavior) +
model + max_turns + max_parallel_runs + optional credentials + enabled.
Agents are pure roles (instruction, statuses, behavior.repository) linked via
the existing `agents.executor_id`; multiple profiles per type are legitimate
("claude-sonnet", "claude-opus", "team-api-key").

- **Schema (0003 amended in place — unmerged)**: `concurrency_limit` RENAMED to
  `max_parallel_runs` (values preserved; snapshot hand-renamed, verified by a
  no-op drizzle-kit generate). architecture §3 + REVIEW-0003 updated.
- **Agent Model field REMOVED**: deleted from AgentForm and from
  `AgentWriteRequest`; the profile's model is the single source of truth. The
  runtime always read the model from the executor config only, so a legacy
  `behavior.model` (live agent "TEST") is ignored unconditionally — pinned by
  an argv-dump test; no data migration.
- **Profile API key**: optional, write-only `api_key` on create/update, sealed
  into the EXISTING `executors.secrets` bytea with the same AES-256-GCM
  envelope as workspace Jira credentials (`secret-box.ts` extracted from the
  credentials codec; key `BRIGADIR_CREDENTIALS_KEY`). Responses carry
  `has_api_key` only; `api_key: null` clears; omitted keeps. Runtime: key set →
  `ANTHROPIC_API_KEY` injected into the spawned claude env (billed by key);
  unset → host subscription. The env allowlist still blocks the HOST's own
  `ANTHROPIC_API_KEY`.
- **Per-profile gate**: the run.<type> worker's own concurrency is the TYPE
  CAPACITY (sum of ENABLED profiles' max_parallel_runs; boot + 15s re-apply);
  before executing a job the processor counts `running` runs on the job's
  profile (via the run's agent → executor_id) and at/over the limit — or for a
  disabled profile — returns the job to waiting via the established rate-limit
  path (`worker.rateLimit(short ttl)` + `Worker.RateLimitError`), consuming no
  attempt. Documented tradeoffs: the rateLimit pause briefly affects the whole
  type queue; the count-then-run check can transiently over-admit under a
  simultaneous first pickup (bounded by type capacity).
- **UI**: Settings→Executors table columns Type / Model (em-dash for mock) /
  Name / Max parallel runs / API key set–— / Enabled; ExecutorForm field order
  Type → Model → Name → rest, Name alias help tip, password api-key input with
  configured/Replace/Clear states, "host subscription" placeholder; AgentForm
  executor picker renders "<type> — <model> (<name>)" ("mock (<name>)"),
  disabled profiles visible but unselectable, Model input gone.
- **Carried live-incident fixes intact** (tests stay green): JQL since-format +
  26h overlap, SSH_AUTH_SOCK allowlist, empty-leftover-branch worktree retry,
  kick-off prompt on claude stdin (+ FAKE_CLAUDE_STDIN_DUMP assertions).

Tests: rename migration fresh + stepwise on live-like data ("mock-exec",
"claude-cli", "Claude Code CLI", agent TEST — rows/ids preserved); api_key
write-only round-trip (has_api_key flips, plaintext never serialized, stored
bytes sealed, clear); per-profile gate (limit-1 profile never exceeds 1 while
a limit-2 profile executes; no attempt burned; disabled profile excluded from
capacity and held, released on re-enable); ANTHROPIC_API_KEY in child env IFF
key set; profile-model-beats-behavior.model. Web: table column order, picker
format, Name tip, api-key form states, AgentForm without Model.

## Iteration 11 — Ticket description in RunContext (lazy Jira fetch, ADF → markdown; 2026-07-14)

Trigger: live incident — the Planner agent on ST3-799 reported "ticket had no
description" and planned from a code diagnosis, while the Jira ticket carried a
full spec. Root cause: `description` was never read anywhere in the pipeline —
the poller requests only status/summary/updated/issuelinks, `tickets` has no
description column, and BOTH run processors hardcoded `description: ''` /
`url: ''` into RunContext, so the wrapper's description slot (wrapper.ts) was
permanently empty. architecture §4 and spec.md ("description как markdown")
promised the field all along; this closes the gap. Chosen shape: **lazy fetch
at run dispatch** via the per-workspace client — NOT via the poller/DB (bodies
are large and hot; the ingest loop stays a cheap status diff, no schema change).

- **`JiraClient.getIssue(key)`** (interface + BasicAuthJiraClient +
  LazyJiraClient delegation): `GET /issue/{key}?fields=summary,description`,
  returns Jira ground truth — `description` as raw ADF (`string` tolerated
  defensively for Server/v2). Conversion is the caller's concern.
- **`adf-to-markdown.ts`** (libs/jira, pure, dependency-free — reverse of
  adf-composer): paragraphs/headings/lists (nested, ordered `attrs.order`),
  codeBlock/blockquote/panel/rule/table/taskList/media/expand, inline
  mention/emoji/inlineCard/status/date, marks strong/em/code/strike/link.
  Unknown nodes NEVER throw — they recurse into `content` (future Jira nodes
  degrade to their inner text). `jiraDescriptionToMarkdown(...)` tolerates
  null/string/ADF and hard-bounds output at 10k chars with an explicit
  truncation marker (wrapper has no budget guard of its own; feature-context
  SECTION_MAX_BYTES precedent).
- **`ticket-detail.ts`** (apps/worker, shared by both processors — same pattern
  as executor-gate): resolves the per-workspace client
  (`JiraClientFactory.forWorkspace`, multi-workspace-correct), fetches, converts.
  A Jira failure MUST NOT fail the job (pipeline.onRunStarted idiom): warn +
  empty description, run proceeds, no attempt burned. The browse URL
  (`{jiraSiteUrl}/browse/{key}`) is built from the DB row OUTSIDE the try — a
  Jira outage still yields a correct link. In the claude_cli processor the
  fetch happens BEFORE the timeout timer starts, so fetch time never eats the
  run budget. Both `load()`s join `workspaces` for `jiraSiteUrl`;
  `buildContext(loaded, detail)` stays sync and pure.
- **Known side effect**: suites seeding placeholder credentials hit
  `decodeJiraCredentials` throw BEFORE any HTTP → instant fallback, no network,
  one warn line — the fallback branch is exercised implicitly across the whole
  existing integration suite.

Tests: adf-to-markdown unit (23 — every node family, mark combos, unknown-node
fallback, truncation, null/string passthrough; literal expected strings + one
composite snapshot); getIssue unit (URL + null-safe parse); integration
(wrapper-feature-context, reusing the suite's live testcontainers stack): ADF
description seeded in mock-jira lands in `wrapper.txt` as markdown (heading,
bold, list, fenced code), and an armed one-shot 500 on GET /issue → run still
`succeeded`, attempt 1, wrapper free of the description text. mock-jira: issue
GET now returns summary+description, `seedIssue({description})`,
`arm500OnNextIssueGet()`.

## Iteration 12 — Human-task details as Markdown (agent instruction + UI reader; 2026-07-14)

Trigger: human-queue task bodies arrived as one unformatted text blob (the
ST3-799 Planner question was a wall of prose) — hard to scan. Two-sided fix:
tell agents to author `details` in Markdown, and render it on the UI.

- **Agent side**: `.describe()` added to the `details` (Markdown) and `title`
  (plain-text one-liner) fields of BOTH `RequestHumanSchema`
  (callback-tools.schema) and `ReportHumanTaskSchema` (report.schema) — the
  text flows through `zodToJsonSchema` into the MCP tool `inputSchema` AND into
  the claude_cli `--json-schema` for complete_task, so the agent sees the
  Markdown expectation on every human-task path. Reinforced in the MCP tool
  `description` (mcp-server/main.ts) and the callback-tools section of the
  instruction wrapper (wrapper.ts). buildArgs snapshot updated (expected —
  now carries the field descriptions).
- **UI side**: `utils/markdown.ts` — a tiny dependency-free Markdown → HTML
  renderer (we add NO markdown/DOMPurify dep). SECURITY: escapes the source
  FIRST, then emits only a curated tag subset (headings, ul/ol, fenced/inline
  code, blockquote, hr, paragraphs, **bold**/*italic*/~~strike~~, links with
  http/https/mailto-only hrefs) — so the `<div v-html>` in the new
  `MarkdownText.vue` carries no author-controlled markup. Wired into
  HumanQueue's task `details` slot; scoped styles size headings/code/lists for
  the card.

Tests: markdown unit (renderer subset + XSS guard: `<img onerror>` escaped,
`javascript:` link degraded to text; emphasis inside code stays literal);
human-queue component test upgraded — the ht-1 fixture is now Markdown and the
spec asserts the rendered `h2`/`code`/`li`×2/`strong` in the mounted view, and
that a details-less task renders no markdown body. Web unit 102 green,
vue-tsc + vite build green. NOT live-dogfooded in a browser (would need the
full testcontainers + backend + worker stack to seed a real queue); the
component test drives the exact render path in jsdom instead.

## Iteration 13 — Persist cost_usd/usage for callback-wired runs (bugfix, 2026-07-15)

Trigger: the Cost column on the Runs page was always empty — verified in the
live DB: 0 of 19 production runs (all `claude_cli` with
`useCallbackChannel: true`) had `cost_usd` set.

Root cause (a feature-004 regression — its data-model marked cost_usd/usage
"unchanged from iteration 3" without revisiting WHEN they are written): cost
exists only in the CLI's terminal stream event (`total_cost_usd`/`usage`),
which arrives at process exit — but a callback-wired run is finalized EARLIER
by the `complete_task` HTTP callback (`finalizeWithReport` with no extra). By
the time the process exits, every status-writing path is a
`WHERE status='running'` no-op (rule #7 — correctly protecting the status),
and the `completed`+callback branch went through `failIfStillRunning`, which
doesn't accept cost at all. Bonus gap: the executor's abort settle dropped an
already-parsed terminal's cost (the cancel-poll kills the lingering process
right after a callback finalize — exactly that path). run_events never carried
cost either, so historic runs are unrecoverable — no backfill.

Fix (minimal, status machine untouched):
- `RunsService.recordCostUsage(runId, {costUsd?, usage?})` — status-independent
  UPDATE by run id (cost/usage are data columns, not state; same precedent as
  the executor's direct `worktree_path` write). Overwrite semantics — the last
  CLI session that emitted a result event wins (user decision; matches the
  pre-existing non-callback meaning). Best-effort, NEVER throws: it sits
  between the executor settling and finalize, and a throw there would fail the
  job and re-run a non-idempotent agent via BullMQ retry (rule #2).
- `ClaudeCliRunProcessor.process`: one `recordCostUsage` call right after the
  executor settles, before any finalize branching — covers all exit paths
  including callback-`completed` (previously lost entirely). Existing finalize
  extras untouched (non-callback double-write is byte-identical).
- Executor abort branch now carries `terminal?.totalCostUsd`/`usage` into the
  settle (handleClose runs post-close, so `terminal` holds whatever was parsed
  before the kill).
- Mock `RunProcessor` gets the same call (guaranteed no-op — mock produces no
  cost) to keep the processors near-copies (FR-009).

Tests: runs.service unit (string conversion, no `status` key in the set,
defined-fields-only, both-undefined → no UPDATE, never-throws); executor unit
(cancelled AFTER terminal parsed → result carries cost/usage); integration
callback-completion — new test: callback finalizes `succeeded`, then cost/usage
land post-exit without clobbering status/report; fail-closed test now also
asserts cost. The limits cancel test deliberately unchanged (its 1s line delay
means the terminal never parses — asserting null would encode timing). Docs:
specs/003 + specs/004 data-model field tables revised, architecture §4 note on
cost post-dating callback finalize.

### Iteration 13 addendum — post-finalize grace (live-run regression, same day)

The first live run through the fixed worker (93ba690e, ST3-870) STILL had no
cost — layer two of the bug: the real CLI prints its terminal result event
seconds AFTER complete_task lands (the model still finishes its turn), and the
processor's cancel-poll saw the run leave 'running' and SIGTERM'd the process
within ~1s of the callback finalize. The result event never existed, so there
was nothing for recordCostUsage to record (the abort-branch fix only helps
when the terminal was parsed before the kill).

Fix: the cancel-poll now distinguishes WHY the run left 'running'. A callback
finalize (succeeded/failed) grants a bounded natural-exit grace
(`postFinalizeGraceMs`, executor-config-overridable, default 30s) before
aborting, so the CLI can emit its result and exit on its own; an explicit user
cancel ('cancelled') and an `awaiting_human` park (process wedged on the
blocking MCP call — it will never exit naturally) abort immediately, exactly
as before (D7 races unchanged; the run timeout still bounds everything).

Test: fake-claude gains a `{tool:'stream', fixture}` step so a scripted run
can emit the result event AFTER its callbacks (production ordering);
callback-completion gets a regression test (complete → sleep 1s ≫
cancelPollMs → stream result) that fails without the grace and proves
cost/usage land with it. `FakeClaudeCallbackStep` widened to the
sleep/stream union in the harness.

---

## Iteration 14 — Orchestrator-based blocked-ticket routing ("brigadir")

Spec: `specs/010-orchestrator-routing/`. Closes the loop on a terminally-failed
worker run instead of letting the ticket die in Blocked: the pipeline auto-starts
one in-process **triage run** for a per-workspace orchestrator agent ("brigadir"),
which returns a new **`routed`** report outcome that either sends the ticket back
to a worker with a written rework task or escalates to a human. A deterministic,
pipeline-enforced rework-cycle budget (default 2, per ticket, derived from run
history) caps the loop with human fallbacks; the Human Queue resume flow gains an
agent picker; a platform **General settings** section holds a centrally editable
default orchestrator instruction.

Schema (migration `0004_orchestrator_routing.sql`, reviewed in `REVIEW-0004`):
`agents.description` (nullable roster line) + `agents.is_orchestrator`
(boolean, marker); new platform-global `global_settings(key, value, updated_at)`
k/v table. `workspaces.settings.rework_max` (jsonb, default 2) — no DDL.

Contracts: `ReportSchema` gains `routed` + a `routing {target_agent, task}`
payload with the `routed⇒routing` superRefine (mirrors `needs_human⇒human_task`).
`TriggerEventSchema` fixes the pre-existing `human_resume`→`human-resume` bug
(the resume flow always WROTE `human-resume`; the enum rejected it, crashing
validation), adds `triage`/`rework` sources + typed handoff fields, and a
`routed` mock scenario. New `global-settings.schema.ts`.

Pipeline (`onRunFinished` is the single completion seam, extended):
- worker completion → the existing failure transition/comment, then the **triage
  decision** (before the marker): budget exhausted ⇒ `cycle_limit` (non-blocking
  human task, no triage); no enabled orchestrator ⇒ `no_orchestrator` (the
  supported off-switch — ticket stays Blocked, **no** human task, per the spec
  Edge Case + data-model §3.2, narrowing FR-005's looser wording); else `triaged`
  (exactly one triage run via `RunTriggerService`). Decision recorded in the
  `jira_action` marker so drift-repair replays no-op (SC-001).
- orchestrator completion (guarded by `is_orchestrator`, takes NO generic
  transition — FR-007): `routed`+valid target+budget ⇒ rework run + direct
  transition to the target's running status + routing comment; invalid target /
  raced budget ⇒ override to a non-blocking human task with the reason;
  `needs_human` ⇒ existing mechanism, no transition; orchestrator `failed`/
  `timed_out` ⇒ human task, **no** re-triage ("the triager is never triaged").
- a `routed` report from a non-orchestrator agent is treated as a failure with
  the invalid outcome noted in the comment (FR-002).

Idempotency/dedup: triage/rework/human-resume are **continuation sources** — they
SKIP the BullMQ `deduplication` layer (`${ticketId}:${agentId}` would be swallowed
by the RETAINED completed job under `removeOnComplete`, leaving the run stuck at
`queued` — the same hazard `ResumeService` documents) and rely on
`runs_one_active` (level 3). `finalizeWithReport` maps `routed`→`succeeded` (the
orchestrator's triage turn is a terminal success).

Handoff (`libs/pipeline/handoff.ts`, `buildHandoffSection(trigger, db)`): an
EPHEMERAL, best-effort, size-bounded markdown block prepended to the assembled
`RunContext.instruction` by both processors — never persisted, the stored agent
`instruction` is byte-for-byte unchanged (SC-002). triage kind (failing summary +
checks + artifacts + worker roster + cycle count + protocol), rework kind (task +
failing context + fix-of-existing-work framing), human-resume kind (question +
answer — replaces the legacy `instructionWithResumeAnswer` append). `rework` also
reuses the existing branch (continuation).

Resume picker: `ResolveHumanTaskSchema` gains optional `target_agent_id`;
`ResumeService` validates (exists ∧ enabled ∧ same workspace, else 400 with
nothing changed), creates the new run for the chosen agent with the attempt
restarted at 1, and transitions the ticket to its running status. Human Queue
list items carry a `workspace` ref so the UI selector loads that workspace's
enabled non-orchestrator agents.

Seeding: `seedOrchestratorAgent(db, workspaceId)` (insert-if-absent on
`UNIQUE(workspace_id, 'brigadir')`) + `ensureOrchestratorExecutor` (a shared
cheap **no-repository** `claude_cli` profile, haiku, `workspace_mode:'none'`) is
called on wizard create, yaml seed, and a startup `OrchestratorBackfillService`.
The claude_cli executor honors `behavior.workspace_mode:'none'`: no clone/worktree
prepare, runs from a scratch temp dir, no `worktree_path`, no git creds in reach
(Constitution V). Orchestrator delete → 409 (API guard); instruction/enabled
edits succeed. `GET/PUT /api/general-settings` round-trips the default
instruction (copied at workspace-creation time only — SC-006).

Tests: contract (report/trigger schemas), unit (handoff kinds + degradation,
non-orchestrator-routed rejection, routing scrub), integration under the mock
executor — full fail→triage→route→rework→success loop + replay no-op (T010),
US2 guards (budget/override/orchestrator-failure/needs_human), resume picker
(T029), orchestrator lifecycle + backfill + delete-guard + default-change (T038),
general-settings round-trip (T039). Web: General settings tab, resume agent
picker, AgentForm description + orchestrator delete hidden. Docs: architecture §3
(schema deltas + `global_settings`) and §6 (`routed` outcome + `routing` payload).

Full suite green: 234 unit, 226 integration, 136 web.

## Iteration 15 — Workspace setup by the orchestrator: "Generate agents" + read-only Jira tools (feature 011, 2026-07-16)

Spec-kit feature `specs/011-workspace-setup` (spec → plan D1–D17 → 43 tasks →
implementation in one pass). The "planning-режим" idea from plan-internal
(2026-07-13) landed on 010's foundation: a NEW workspace is created **paused**
(`settings.enabled=false`, wizard + yaml seeder); an explicit **Generate agents**
action (`POST /api/workspaces/:id/generate-agents`, button on the Agents tab
while the roster is orchestrator-only) starts a **ticketless setup run** of the
seeded brigadir (trigger source `workspace-setup`, no repo, cheap profile). The
orchestrator studies the project through new **read-only Jira callback tools**
and returns a one-shot **`team` report outcome**; the accept path validates the
proposal all-or-nothing (names ∪ existing ∪ 'brigadir', statuses against the
live board via lintAgent, executor profiles by NAME, trigger collisions) and
applies it in ONE transaction: agents created **enabled** + a ticketless
non-blocking review task + guarded finalize. Invalid proposals bounce back as
422 through complete_task — a repair loop inside the run (FR-017 amended at
planning, research D9) — so Constitution IV holds with no post-finalize
demotion; a run that never lands a valid proposal fail-closes into a
"Workspace setup failed" human task and is never triaged. The single gate
stays the existing Start switch.

Schema (migration 0005 + REVIEW): `runs.ticket_id` / `human_tasks.ticket_id`
DROP NOT NULL; new partial unique `runs_one_active_setup (workspace_id) WHERE
active AND ticket_id IS NULL` (unique-index NULLs are distinct — `runs_one_active`
cannot cover setup runs). `workspace-setup` joins the BullMQ-dedup skip set;
generate preconditions + the index give idempotency in depth. Ticket-optional
plumbing end to end: processors left-join tickets, `RunContext.ticket` nullable,
wrapper renders a setup header, JWT `tkt` claim optional (guard never checked
it), runs/human-tasks controllers left-join + serialize `ticket: null`, runs
list gains a `source` filter (drives the button state on the existing poll).

Read-only tools (US2, for EVERY callback-wired run): `get_project_overview`,
`search_tickets` (structured filters — raw JQL never accepted, the backend
composes `project = <ws>` + `sprint in openSprints()` for scrum), `get_ticket`
(description + last 20 comments + links, project-key scope check → 403
`out_of_scope`). Served by `JiraReadService` behind the existing RunTokenGuard
via `JiraClientFactory` (credentials never reach the agent; zero write surface);
responses size-bounded with `truncated` flags. `JiraClient` gains
`getIssueDetail`/`searchIssues`/`getProjectIssueTypes`. The setup handoff
(new `buildHandoffSection` branch) stays DB-only: digest (board/repos/profiles)
+ protocol pointing at the tools + resume Q&A; mock scenarios `team`/`team_invalid`
drive the loop deterministically (roster via `behavior.team_proposal`).

Resume of a parked setup run creates ANOTHER `workspace-setup` run carrying the
Q&A (never answer-triage; `target_agent_id` on ticketless tasks → 400). UI:
Generate button states (offer/progress-link/hidden), "Workspace setup" labels
at all four ticket-render sites, resume picker hidden for ticketless tasks,
create-flow hint. Docs: architecture §3 (nullable + new index), §5 (read tools +
tkt? claim), §6 (`team` outcome).

Tests in the same change: contracts 77, mcp-server 14, unit 244, integration
249 (incl. the full Scenario A loop, generate race SC-003, atomic rejection
SC-004, replay SC-007, read-tool scope/truncation/guard parity SC-005), web 160.

## Iteration 16 — zod 3 → zod 4 migration (2026-07-16)

Whole-monorepo bump to `zod@^4` (installed 4.4.3), dropping `zod-to-json-schema`
entirely: both JSON Schema production sites (`--json-schema` argv in
`libs/executors/src/claude-cli/args.ts` and the MCP `inputSchema` in
`packages/mcp-server/src/main.ts`) now use the native `z.toJSONSchema(schema,
{ target: 'draft-7' })` — the target is PINNED to draft-07 deliberately, so the
wire dialect fed to the claude CLI and MCP clients does not change with the
migration (zod 4 defaults to draft 2020-12; switching dialects is a separate
decision, not a side effect). The `zodToJsonSchemaUntyped` boxing hack (zod
3.25 v3/v4 declaration split) died with the dependency.

Code deltas were small: `z.ZodIssueCode.custom` → literal `'custom'` (8 sites,
valid in both versions), and zod 4 widening `issue.path` to `PropertyKey[]` —
handled centrally by a new `zodIssuePath()` helper in
`apps/backend/src/dashboard/dashboard.errors.ts` (symbols stringified; the wire
`ErrorIssue.path` stays `(string|number)[]`), used by every controller that
serializes zod issues into 422 bodies. `z.record` call sites were already
two-argument. Deprecated-but-functional v3 idioms (`.strict()`, `.passthrough()`,
`z.string().uuid()/.url()`) left as-is — cosmetic modernization deferred.

Motivation (analysis 2026-07-16): native converter maintained with the schemas
(kills a third-party fidelity risk), ~100× fewer type instantiations for the
strict monorepo typecheck, smaller client bundle for apps/web, and the upcoming
admin-mcp package gets `.meta()`/`z.toJSONSchema` first-class instead of a
schema-parity test against v3 contracts.

Verified: args snapshot updated after asserting the draft-07 output is
semantically identical ($schema, enums incl. `team`, required, additionalProperties,
bounds, descriptions). Full gates green: contracts 77, mcp-server 14, unit 244,
web 160, integration 249.

## Iteration 17 — Admin MCP server `brigadir-admin` (feature 012, 2026-07-16)

Spec-kit feature `specs/012-admin-mcp` (spec → plan with Constitution Check → tasks →
implementation). A NEW package `packages/admin-mcp` ships the stdio MCP server
`brigadir-admin` — the manual, human-in-the-loop precursor to the workspace-orchestrator
planning mode (plan-internal, "админский MCP «Claude-тимлид»"). A human plugs it into
Claude Code and asks "assemble a team for this board"; Claude does recon and creates the
workspace + agents through the tools.

Sharp line vs the callback MCP (`packages/mcp-server`): that one is for an agent INSIDE a
run (per-run JWT, callback tools); this one is the admin plane for a human+Claude OUTSIDE
any run (dashboard bearer, create workspaces/agents). The server is a THIN HTTP client of
the dashboard admin API — zero DB access. Secrets live ONLY in its env
(`BRIGADIR_API_URL`, `BRIGADIR_DASHBOARD_TOKEN`, `BRIGADIR_JIRA_EMAIL`,
`BRIGADIR_JIRA_API_TOKEN`, fail-fast `requireEnv`): the bearer goes into the header, the
Jira creds are injected server-side into the `POST /api/workspaces` body — the model never
sees or passes them (Principle V; a unit test proves a smuggled `jira_api_token` arg is
ignored). stdout is MCP protocol only; a 4xx surfaces to the model as a tool error WITH the
response body (path-qualified issues to repair from), no retry; 5xx/network → bounded retries.

Nine tools (5 read: `list_workspaces`, `get_workspace`, `get_board_statuses`,
`list_executors`, `list_agents`; 4 write: `create_workspace` — output `enabled` pinned to
literal `false` since the backend creates workspaces PAUSED (feature 011), no start tool;
`generate_agents`; `create_team`; `create_agent`/`update_agent`). Every tool declares an
`inputSchema` AND an `outputSchema` (MCP structured output — `structuredContent` + a text
duplicate); schemas are zod 4 in `packages/contracts/src/admin-tools.schema.ts` (single
typed source), reusing `TeamAgentSchema`, converted with
`z.toJSONSchema(schema, { target: 'draft-7' })`. Handlers project backend rows into the
declared strict output shapes.

The only new backend surface is `POST /api/workspaces/:id/team` (DashboardTokenGuard):
atomic team spawn reusing the feature-011 validator + applier. Refactor of
`SetupApplyService`: `validate` → public `validateTeam`, agent insert extracted to
`insertTeamAgents`, and a new `createTeamDirect(workspaceId, agents)` that validates +
inserts in one transaction WITHOUT a run and WITHOUT a review task — the run-bound
`acceptTeamReport` path shares both helpers and is behavior-identical (feature-011 suite
unchanged). All-or-nothing: an invalid agent ⇒ 422 with path-qualified issues and ZERO
created; precondition 409 `worker_agents_exist` (v1 does not rebuild teams). No Jira writes
anywhere (Principle III). `DashboardModule` imports `PipelineModule` for the service.

Tests in the same change: contracts +7 (`admin-tools.schema.spec.ts` — toJSONSchema
draft-07 for every input+output, TeamAgent reuse, roster bounds, `enabled:false` const,
secret-field rejection), admin-mcp 14 (handler units with injectable `fetchImpl`: URL/method/
headers per tool, secret-cannot-be-smuggled, 4xx→error no-retry, 5xx→bounded retries,
create_workspace injects env creds, update_agent strips agent_id), plus the integration
spec `test/integration/admin-mcp.integration.spec.ts` (create_workspace→enabled=false;
create_team atomic invalid⇒422 zero-created + happy path; worker_agents_exist; generate_agents
202/409). Gates green locally: typecheck, lint, contracts 84, mcp-server 14, admin-mcp 14,
unit 244. The testcontainers integration suite could not run in this environment (the Docker
registry CDN `production.cloudfront.docker.com` is blocked by egress policy — 403 — so
postgres/redis/ryuk images cannot be pulled); the integration spec typechecks and follows the
existing harness patterns and should be run where Docker is available.

## Iteration 18 — Suggested answer options on human tasks (feature 013, 2026-07-16)

Spec-kit feature `specs/013-human-task-answer-options` (spec → plan with Constitution
Check → tasks → implementation). When an agent asks a human a question — via the
`request_human` callback tool OR the `human_task` payload of a `needs_human` report —
it can attach up to 5 predefined answer options. The Human Queue drawer renders them
as one-click buttons; a click PRE-FILLS the answer input with the option's `value`
(default: `label`), the free-text field stays below as the always-available custom
answer, and the human still presses the existing explicit Submit (no auto-submit).
The chosen option submits as an ordinary STRING through the existing `answer` field
of `POST /api/human-tasks/:id/resolve` — `resume.service.ts`, the handoff Q&A
rendering, and answer-triage changed ZERO lines by design.

One schema home (research D1): `packages/contracts/src/answer-option.schema.ts` —
`AnswerOptionSchema` (`{label ≤80, value? ≤500, description? ≤200}`, `.strict()`,
`.describe()` coaching "offer options whenever the answer is a choice, not an essay")
+ `AnswerOptionsSchema` (1–5; empty array invalid — "no options" is the omitted
field). Reused by `RequestHumanSchema`, `ReportHumanTaskSchema` (additive optional,
`schema_version` stays 1), and `HumanQueueItemSchema` (nullable, served by the global
list and the workspace Human queue tab from the one shared select). Storage: nullable
`human_tasks.options` jsonb (migration `0006` + `REVIEW-0006`, §3 amended in the same
change); system-composed tasks (PR review, triage-limit, orchestrator failure, team
review) carry NULL. `label`/`value`/`description` pass the scrubber in
`callback.service.ts` on BOTH intake paths (Constitution V) — which also covers the
Jira side, since `buildHumanTaskComment` renders from the scrubbed input: options
appear as a plain ADF bullet list ("Suggested answers:", label — description; `value`
is machine-facing and never rendered; no buttons in Jira — answering stays in the
dashboard; the no-options document is byte-identical, existing snapshot held).
Agent discovery: one sentence in `callbackToolsSection` + a hint in the
workspace-setup handoff — stored agent instructions untouched. The mock executor's
`needs_human` scenario is parameterized via `trigger_event.mock_options` (typed
optional, `.passthrough()` schema) so the loop is drivable without live agents.
The claude-cli args snapshot moved because the `--json-schema` fallback derives from
`ReportSchema` (expected additive change).

Tests in the same commits (Constitution VI): contracts (bounds, max 5, strict, both
intake surfaces, HumanQueueItem requires nullable options), callback units (canary
secret scrubbed in option texts on both paths; 6-option payload → validation, nothing
delegated), mock-executor unit, ADF snapshots with/without options, wrapper prose on
both channels, web MSW suite `human-task-options.spec.ts` (buttons render with
label+description and a row hint; click fills value/label; last click wins; custom
text overrides; no resolve call on click; `options: null` renders exactly as before —
`human-queue.spec.ts` green UNTOUCHED), and the integration suite
`human-task-options.integration.spec.ts` (request_human with options → scrubbed row →
global + scoped list carry them → Jira comment lists them → resolving with the
option's value lands in `resolution` and the resumed run's handoff renders
`Question:`/`Answer: migrate`; mock needs_human via `mock_options`; PR-review task
options NULL; 6-option payload 422 with the run untouched).

Gates green locally: typecheck, lint, unit 251 (39 files), web 165 (26 files),
integration 260 (75 files, full suite). Docker note: the registry CDN block from iteration 17 was
worked around by running dockerd with `--registry-mirror=https://mirror.gcr.io`
(gcr mirror is reachable through the egress proxy), so the testcontainers suite ran
in this environment this time.

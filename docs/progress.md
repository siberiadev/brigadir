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

## Iteration 19 — Agent identity: persona name, role, routing key (feature 014, 2026-07-16)

Separated an agent's identity from its presentation. The immutable UUID `id`
stays the sole internal reference (joins, FKs, idempotency, resume — all already
by id). `name` became a free, non-unique persona ("Achilles", "Hera"); a new
`role` (text, nullable) carries the function ("Developer"/"QA"/"Reviewer";
orchestrator = "teamlead"); and a new `key` (text NOT NULL, `UNIQUE(workspace_id,
key)`) is the readable, immutable HANDLE used ONLY at the LLM/UI boundary
(routing, URLs, logs), resolved to `id` at that boundary. Why key and not id:
routing passes through the LLM (brigadir returns `target_agent` as free text) —
it echoes a short slug reliably where it mangles a UUID.

One canonical slug: `packages/contracts/src/agent-key.ts` (dep-free, like
`pagination.constants`) exports `slugifyAgentKey(name, role)` (lowercase,
non-`[a-z0-9]`→`-`, collapse, trim; empty → role slug → `agent`),
`ensureUniqueAgentKey(base, taken)` (smallest free `-2`/`-3`, reserved keys always
taken), and `ORCHESTRATOR_AGENT_KEY = 'brigadir'` / `RESERVED_AGENT_KEYS`. The
system derives keys ONCE at creation on EVERY path (in-run team apply, backend
create = dashboard + admin-MCP passthrough, config-seeder, orchestrator seed,
backfill); the UPDATE path never touches key (the write schemas stay `.strict()`
with no `key` field, so a supplied key is a 422 — the "reject" resolution, free).

Decisions (spec 014, research D1–D8): orchestrator key `brigadir` reserved (role
lives in the editable `role` field, so encoding it in the immutable key would
freeze editable data; reservation makes it unobtainable by workers — D1); theme
picked by the LLM with NO theme list in code (the setup handoff prompts "invent
ONE coherent theme", examples illustrative — D8); backfill deterministic (worker
key = slug of current name, role NULL; orchestrator role `teamlead`, key
`brigadir`; collisions suffixed in id order — D3). Two `/speckit-analyze` findings
folded in: intra-proposal team dedup is by DERIVED KEY not name (I1 — two personas
slugging alike are bounced back; the old duplicate-vs-existing-name check is gone
since names may now repeat), and `role` is OPTIONAL in `TeamAgentSchema` (required
by prompt) to keep `ReportSchema` v1 forward-compatible without a disproportionate
top-level `schema_version` bump (C1).

Routing: `resolveRoutingTarget` matches `agents.key` (still enabled ∧
non-orchestrator ∧ workspace); unknown/disabled/reserved key → human-task
escalation (unchanged behavior). Roster in the handoff renders
`- <key> — <name> (<role>): <description>` and instructs routing by key.
Human-facing text shows "name (role)" (team review task) or the key (logs, the
ADF routed line prints `target_agent` = key verbatim). Dashboard: `AgentResponse`
+ key/role, agents list `ORDER BY key` (name is no longer a deterministic sort
key); run/human-queue embedded agent DTOs + key/role. Web: AgentForm gains an
editable Role and a read-only Key (edit only); AgentsList shows name (role) + a
monospace key column.

Migration `0007_agent_identity.sql` + `REVIEW-0007` (§3 updated in the same
change): drizzle-kit generated the DDL/snapshot/journal; the backfill DO-block
(orchestrator UPDATE, then per-workspace worker slug + deterministic suffixing in
id order, reserved `brigadir` seeded into `taken`) was hand-added between
`ADD COLUMN key` (nullable) and `SET NOT NULL`. Its slug is a faithful SQL port of
`slugifyAgentKey`; an integration test asserts byte-parity with the TS functions.

Tests in the same iteration (Constitution VI): `agent-key.spec` (slug rule, empty
fallback chain, suffixing, reserved); `agent-crud` +5 (key derived server-side,
immutability on rename, `key` in update → 422, same-name → distinct keys,
reserved-key persona → `brigadir-2`, list ORDER BY key); `agent-identity.integration`
(the REAL migration backfill statements read from the .sql, run against
pre-feature-shaped rows — orchestrator, slug collisions, reserved collision,
non-Latin name — asserting SQL↔TS key parity + constraint swap); `workspace-setup`
(team apply derives key+role; two personas slugging to one key → 422, zero agents);
routing loop/guards updated to route by key; `handoff.spec`/`answer-triage` roster
format; the `--json-schema` argv snapshot (expected, additive). Resume path
verified id-based (untouched).

Gates green locally: typecheck (all packages) + web vue-tsc, lint, unit 251 (39
files) + contracts 107 (12) + admin-mcp 14 + web 165 (25), integration 268/269 —
the one failure (`serve-static` SPA fallback) reproduces identically on the
pristine tree (web `dist` not built in this worktree), i.e. pre-existing and
unrelated to this feature.

## Iteration 20 — Editable brigadir instructions + repo-recon setup protocol (2026-07-17)

Two operator-editable brigadir texts in Settings → General, each with its own
"Reset to default": the **routing (triage)** instruction (the existing
`default_orchestrator_instruction` key — unchanged semantics: copied into the
seeded orchestrator at workspace creation, SC-006) and the new **agent-creation
(workspace setup)** protocol (`workspace_setup_instruction` key). The setup
protocol was previously hardcoded prompt lines in
`libs/pipeline/src/handoff.ts::buildWorkspaceSetupSection`; it is now read LIVE
per generate-agents run (`getWorkspaceSetupInstruction`, fallback to the
built-in), truncated to the same 20k cap the PUT schema enforces. The dynamic
digest (workspace, repositories, executor profiles) and the Q&A block stay
assembled around it. No DB migration — both keys live in the existing
`global_settings` KV table.

Built-in texts moved to `packages/contracts/src/orchestrator-defaults.ts`
(dep-free module; `@brigadir/database` re-exports for the old import path) so
the web app imports them at runtime via the
`@brigadir/contracts/orchestrator-defaults` alias (pagination-constants
pattern) for client-side Reset. `GET/PUT /api/general-settings` now round-trips
both fields (strict — both required).

The new DEFAULT setup protocol upgrades team quality (root cause found by
comparing two live workspaces' generated teams, 2026-07-16): a conditional
code-recon step (clone connected repos into `.repos/<name>`, read
AGENTS.md/README/CLAUDE.md + `.specify/memory/constitution.md`, extract gate
commands — best-effort, skipped without repo access) and a "How to write each
agent's instruction" section (project-specific commands, per-repo hard rules,
multi-repo handling, completion contract, escalation, and the platform rule
that workers NEVER write to Jira — the system transitions from their report).
Known limitation: the seeded `brigadir-orchestrator` profile is
`workspaceMode:'none'` (Haiku, 15 turns), so the recon branch stays dormant
until the workspace's brigadir agent is pointed at a repo-capable executor —
candidate follow-up: repo-mounted setup runs.

Tests in the same iteration: handoff unit spec + workspace-setup branch
(built-in protocol rendered; stored override replaces it; no-ctx degrades to
''), global-settings integration (both fields round-trip, both required,
strict), web settings-page spec (both fields seeded, Reset restores built-ins,
Save PUTs both). Gates green: typecheck (all packages + vue-tsc), lint, unit
254 (39 files), web 166 (25), affected integration suites 11/11
(global-settings, workspace-setup).

## Iteration 21 — Configurable brigadir template + repo-mounted setup runs (feature 015, 2026-07-17)

Two blocks (specs/015-brigadir-agent-repo-setup). **Block 1**: a new Settings →
"Brigadir agent" section holds the editable TEMPLATE of the default
orchestrator — persona name, role, triage executor profile (by NAME), triage
workspace mode, limits (timeout/budget/attempts), enabled — plus BOTH brigadir
instruction texts relocated from General (General keeps only Theme).
`seedOrchestratorAgent` now copies the template into every NEW workspace
(copy-at-creation; existing workspaces untouched — feature 010 SC-006). Storage:
ONE versioned JSON document under `global_settings['brigadir_agent_template']`
(`BrigadirAgentTemplateSchema`, contracts) — no migration; the two instruction
texts kept their existing keys, so operator edits survived the endpoint move
(`GET/PUT /api/general-settings` → **removed**, replaced by
`GET/PUT /api/brigadir-agent-settings` which composes template + both texts;
PUT validates bounds and that referenced executors exist AND are enabled, 422
field-level). A template executor deleted AFTER save falls back to the built-in
profile at seed time + `warnings[]` in the create response (toasted by the web
create flow); a corrupt stored template reads as built-in defaults (never 5xx).
Reset UX: per-field for both instruction texts + a confirmed "Reset all to
defaults" (unsaved until Save).

**Block 2 — fat setup, thin triage**: runs with trigger source
`workspace-setup` now resolve their environment from the template's `setup`
execution profile, read LIVE at run start (matches the setup instruction's
lifecycle): new built-in `brigadir-setup` profile (claude_cli, Sonnet 5,
maxTurns 60, maxParallelRuns 1, repo-mounted), dedicated
`setup.timeout_minutes` (default 60, applied by the claude-cli processor —
sized for clones), workspace default repo mounted as the working dir with a
ticketless local-only branch `setup/<runId8>` (`setupRunBranchIdentity`; the
"ticketless run requires no-repo agent" guard narrowed to non-setup sources).
Degradations never fail the run: no default repo → scratch no-repo path
(FR-017); setup executor missing/disabled → `ensureSetupExecutor` fallback + a
`run_events` warning (FR-018). Triage runs byte-identical (cheap Haiku
profile, no repo, no git). **Principle narrowing recorded** (plan.md
Constitution Check + Complexity Tracking): feature-010's "orchestrator has no
repository/git credentials" now applies to TRIAGE runs only; setup-run
read-only-ness is behavioral (no push path, no push instruction, local-only
branch) over the same host ssh-agent posture all repo runs share.

Tests in the same iteration: contracts schema spec; executor unit spec
(profile swap incl. `--model`/`--max-turns` args, ticketless `setup/<runId8>`
prepare, disabled-executor fallback event, no-repo degradation, guard
narrowing, triage unchanged); worktree identity spec; NEW
brigadir-agent-settings integration suite (defaults, round-trip, 422s,
legacy-key continuity, live-read continuity, corrupt template, last-write
wins); orchestrator-lifecycle extended (template-driven seeding, SC-002,
fallback warning, corrupt template, enabled=false); workspace-setup extended
(template PUT live-read by the very next generate run); executor-seeding /
config-seed updated for the second built-in profile; web specs for the new
section (resets, reset-all, issue pinning, behavior round-trip) and theme-only
General.

Gates green locally: typecheck (root tsc + contracts + mcp-server + admin-mcp)
+ web vue-tsc, lint, unit 261 (39 files) + contracts 117 (13), web 173 (26,
incl. the new settings-brigadir-agent spec), integration 278/279 — the one
failure (`serve-static` SPA fallback) reproduces identically on the pristine
tree (same environment issue recorded in iteration 19), i.e. pre-existing and
unrelated. Quickstart Scenario 3 (live-model repo recon quality, SC-003)
remains a manual check by design.

## Iteration 22 — Default toolset for repo-mounted runs (ST3-768, 2026-07-17)

Live incident (ST3 SPR31): a generated worker ("Fogg") could not produce the
ST3-768 spec branch — every `Write`/`Edit`/git-write call was auto-denied, the
run parked on `request_human`, and even after the human answered "enable
write + git permissions and resume" the rework run failed on byte-for-byte
the same denials. Root cause chain: `claude_cli` runs always spawn with
`--permission-mode dontAsk` (allowlist-only, by design), the allowlist
resolves `executors.config.allowedTools` → `agents.behavior.allowed_tools` →
**empty**, generated teams are inserted with `behavior: {}`
(setup-apply), and the seeded `claude` profile declares no `allowedTools` —
so every generated worker ran with just the 6 `mcp__brigadir__*` callback
tools. The "resume" answer could not help by construction: permissions are
argv, fixed at spawn; the human answer only rides the handoff prompt text,
and brigadir's rework task falsely promised "permissions are now enabled".

Decision: **the platform default, not brigadir, decides tools.** Runtime
permission granting is impossible (argv) and undesirable (LLM as permission
authority); per-agent narrowing stays an OPERATOR override via the existing
`executors.config.allowedTools` / `agents.behavior.allowed_tools` fields.

- `DEFAULT_REPO_RUN_ALLOWED_TOOLS` (claude-cli.config.ts): full coding
  toolset (Read/Glob/Grep, Write/Edit/MultiEdit/NotebookEdit,
  TodoWrite/Task/Skill, unrestricted Bash, WebFetch/WebSearch). Guardrails
  are the per-run worktree, timeout, and budget — not tool granularity.
- Applied in `loadRunConfig` ONLY when the resolved allowlist is empty AND
  the run is repo-mounted, AFTER repo resolution — a setup run degraded to
  the scratch no-repo path (FR-017) and triage runs (workspace_mode 'none')
  keep the empty allowlist. Explicit config on either level always wins.
- `DEFAULT_ORCHESTRATOR_INSTRUCTION`: brigadir is told tool permissions are
  fixed at spawn and it must never promise they "have been enabled" — a
  permission-denial failure routes to `needs_human` naming the config field
  a human must edit. (Copied-at-creation: existing workspaces need "Reset to
  default" or a manual edit to pick this up.)

Deliberately NOT done: seeding `allowedTools` on the `claude` profile (empty
now means "track the platform default"); `allowed_tools` in the team-proposal
schema (brigadir doesn't pick permissions, v1); relaxing the legacy YAML
`agents-config` refinement that requires explicit tools (that path stays
strict).

Tests in the same iteration: executor spec — default applied on a repo-mounted
run (argv `--allowed-tools`), agent/profile overrides win, triage stays empty,
setup run gets the default (FR-013 test extended), FR-017 degrade stays empty.
Gates green: typecheck, lint, unit 265 (39 files) + contracts/mcp-server/
admin-mcp package suites.

## Iteration 23 — UI polish: role/executor columns + human-queue newest-first (feature 016, 2026-07-17)

Four small dashboard improvements, one behavioral change. **Решение
пересмотрено**: OPEN-таб needs-human очереди теперь сортируется
**newest-first** (`created_at DESC, id DESC`) — сознательный разворот решения
feature 006 «oldest-first / longest-waiting on top». Одна правка `ORDER BY` в
`HumanTasksController.list()` покрывает обе поверхности (глобальный
`/human-queue` и вкладку воркспейса — общий компонент и эндпоинт). History-таб
остался `resolved_at DESC`, но получил тот же `id DESC` tie-breaker: правило
детерминированного ORDER BY для пагинированных эндпоинтов теперь выполняется
на обеих ветках (одинаковые `created_at`/`resolved_at` больше не тасуют строки
между страницами).

Остальное — read-only отображение, ноль изменений контрактов и БД:
- **Runs-таб**: новая колонка Role из `run.agent.role` (уже был в ответе);
  без роли — em dash (идиома колонки Cost).
- **Agents-таб**: «Name (role)» разделён — Name показывает только персону,
  роль ушла в отдельную колонку тегом (`el-tag size="small"`, цвета из темы);
  без роли — пустая ячейка. Key не тронут.
- **Agents-таб**: новая колонка Executor — ИМЯ профиля исполнителя, резолвится
  на клиенте через существующий `useExecutors` (whole-list `page_size=100`,
  `Map<id, name>`); нерезолвящийся id / незагруженный список → пустая ячейка,
  сырой UUID не показывается никогда.

Tests in the same iteration: integration human-queue переписан на
newest-first + новый describe про tie-break и пагинированный обход без
дублей/пропусков (падал до правки контроллера — TDD); web: новый
`agents-columns.spec.ts` (Name/Role split, тег, пустые ячейки, резолв имени
executor, fallback при упавшем лукапе), runs-table расширен (Role + em dash),
human-queue — рендер серверного порядка на обеих поверхностях.

Gates green: typecheck + vue-tsc, lint, unit 261 + contracts 117 + mcp 14 +
admin 14, web 181 (27 файлов), integration 280/281 — единственный fail
(`serve-static` SPA fallback) — известный environmental, воспроизводится на
чистом дереве (записан в итерации 19/21). Визуальный spot-check всех четырёх
изменений сделан в браузере на dev-сервере ворктри против мок-API (живой
бэкенд пользователя не трогали).

## Iteration 24 — Home dashboard landing page (feature 017, 2026-07-17)

`/home` — новая посадочная страница: hero-виджет human queue (top-5 старейших
+ total из ТОГО ЖЕ ответа списка), плитки running/queued/failed-24h/awaiting-
human, кросс-workspace списки «Needs attention» (failed/timed_out за 24ч) и
«Live runs» (с посекундным тикером от `started_at`, clamp ≥ 0), карточки
workspace'ов с агрегатами и платформенный Spend 24h/7d/30d. `/` → redirect
`/home`; список workspace'ов переехал на `/workspaces` (имя роута `workspaces`
сохранено — все `router.push({name})` работают без правок); one-shot редирект
`/`→`/human-queue` из 006 удалён (hero отвечает на тот же вопрос заметнее).

Backend (все — за DashboardTokenGuard, read-only, без изменений схемы БД):
- `GET /api/home/summary` — счётчики + spend за все три периода одним ответом
  (switcher чисто клиентский). Spend оконён по `created_at` — как
  per-workspace cost, поэтому платформенная цифра = Σ workspace-цифр (SC-004,
  закреплено интеграционным инвариант-тестом). Провалы — по `finished_at`.
- `GET /api/runs` — ограниченный кросс-workspace список: `status` (CSV)
  ОБЯЗАТЕЛЕН (422 без него), `limit` ≤ 50 (мусор → дефолт 10, конвенция
  `.catch()`), фиксированный композитный ORDER BY (running старейшие →
  queued старейшие → терминальные по finished_at DESC, tie-break id);
  `{items, total}` — НЕ пагинационный конверт (top-N с "showing N of M").
- `GET /api/home/workspaces` — карточная проекция: ≤4 батч-запроса
  (DISTINCT ON для last run — едет по `runs_workspace_created`), paused из
  `settings.enabled === false`, без fan-out per card.

Контракты — `home.schema.ts` (strict, snake_case, переиспользованы
RunStatusSchema/RunCostPeriodSchema/RunTicketRefSchema). Отклонение от
спеки: у «view all» для глобальных списков нет назначения (глобальной
страницы runs не существует и она вне скоупа) — вместо ссылки overflow-note
«showing N of M»; hero и грид ссылаются на свои реальные страницы.

Тесты той же итерацией: контрактные (home.schema.spec), интеграционные
home-summary (нулевое состояние, окно 24ч, Σ-инвариант против
per-workspace cost, консистентность с /api/runs и /api/human-tasks/count),
runs-global (422-матрица, ordering, limit, ticketless), home-workspaces
(агрегаты, paused, runless), dashboard-auth (+3 новых роута), веб —
home-dashboard.spec (24 сценария: тикер real-timers, spend без refetch,
per-block degradation) + правки app-sidebar/workspace-tabs под новый роутинг.

Пост-мерж коллизия с фичей 016 (влилась в main тем же днём): 016 намеренно
перевернула open-очередь на newest-first, а hero 017 требует СТАРЕЙШИЕ 5
(спека FR-005: longest-waiting = самое срочное). Решение (подтверждено
оператором): аддитивный параметр `?order=oldest|newest` на
GET /api/human-tasks (дефолт — newest-first 016-й, страница очереди не
меняется; мусор → дефолт через `.catch()`); hero опрашивает `order=oldest`
(зеркальный tie-break id ASC). Тесты: интеграционные кейсы flip/garbage в
ordering-сьюте 016, веб-кейс «hero шлёт order=oldest».

## Iteration 25 — Diagram view mode на странице Agents (feature 018, 2026-07-17)

Тумблер List/Diagram на `/workspaces/:id/agents` (List — дефолт, выбор
нигде не персистится) и интерактивный граф эмерджентного пайплайна:
статус-ноды живой борды + ноды видимых worker-агентов; рёбра
trigger (primary, status→agent), success (сплошное, success) и failure
(пунктир, danger) — оба agent→status. Оркестратор и disabled-агенты
скрыты; статусы без единого видимого агента — muted (dashed, кандидаты
под новых агентов); статус, на который ссылается агент, но которого нет
на борде — missing-нода с danger-обводкой (дрейф конфига виден, ребро
сохраняется). `status_running` сознательно НЕ ребро и не считается
referenced (транзитная парковка). JQL-бейдж на ноде агента (tooltip —
сырой JQL); jql-only агент — нода без входящего ребра.

Архитектура: чистая производная от двух живых запросов — НИКАКОГО нового
бэкенда/схемы/персиста. `buildGraph.ts` (pure, детерминированный порядок)
+ `layoutGraph` (dagre LR, циклы/self-loops ок) → Vue Flow
(`@vue-flow/core` 1.48, слот-ноды `StatusNode`/`AgentNode` на Element
Plus). Ключ whole-list запроса агентов побайтово равен ключу AgentForm
(`{page:1,page_size:100}`) — один кэш-энтри TanStack, консистентность
list↔diagram и авто-перерисовка после save бесплатно от существующей
инвалидации `['agents', wsId]`. Переключение режима не фетчит ничего
(запросы живут в setup вьюхи); плата — eager-загрузка whole-list+statuses
при заходе на вкладку.

Интеракции: «+» на КАЖДОЙ статус-ноде → существующий AgentForm с
префиллом trigger_status (новый seed-only проп `initialTriggerStatus`,
edit-режим его игнорирует; ключ диалога расширен префиллом — повторные
«+» пере-сидят форму); карандаш на ноде агента → тот же Edit-диалог, что
в таблице. Цвета только через `--el-color-*`, иконки lucide статичные,
`prefers-reduced-motion` гасит переходы; позиции нод и режим не
сохраняются (каждый рендер — свежий dagre-layout).

Тесты той же итерацией: agents-diagram-graph.spec (18 кейсов чистой
деривации: видимость, рёбра, muted/missing, циклы/self-loop, детерминизм,
пустые statuses → все referenced missing) + agents-diagram-view.spec
(12 интеракционных, VueFlow застаблен с прокидкой слотов: дефолт List,
тумблер без единого нового запроса (счётчик msw), «+»-префилл и
пере-сид, save→закрытие→новая нода, cancel-неизменность, edit точного
агента, disabling-edit убирает ноду) + 4 кейса префилла в
agent-form.spec. jsdom-грабля: у радио el-segmented нет value-атрибута —
выбор по индексу; в test/setup.ts добавлен no-op ResizeObserver.

## Iteration 26 — Bulk stop: кнопка «Stop all runs» на странице Runs (2026-07-17)

Проблема: пауза workspace не трогает уже активные прогоны — они дорабатывают
до конца. Добавлен bulk stop: `POST /api/workspaces/:id/runs/cancel-all` —
один guarded UPDATE, флипающий все `queued` + `running` прогоны workspace в
`cancelled` (`finished_at = now()`), ответ `{ ok, cancelled_count }`
(контракт `RunsCancelAllResponseSchema`). `awaiting_human` сознательно вне
скоупа (правило №7 — парковку не затирает никакая bulk-операция); чужие
workspace не задеваются; повторный вызов — идемпотентный no-op (count 0).
Механика остановки — существующая: у `running` процессов cancel-poll воркера
видит неактивную строку и убивает CLI; отменённый `queued` дропается на
пикапе (`markRunning` → false). Попутно закрыт дрейф от правила №7 в
mock-`RunProcessor`: он игнорировал результат `markRunning` и исполнил бы
отменённый queued-прогон — теперь job дропается, как в
`ClaudeCliRunProcessor`.

UI: кнопка «Stop all runs» (danger plain) в шапке страницы Runs, действие
только после `ElMessageBox.confirm` (текст явно говорит, что awaiting_human
не затрагивается); успех — `ElMessage` со счётчиком; мутация
`useCancelAllRuns` инвалидирует `['runs', wsId]`, чтобы таблица обновилась
сразу, не дожидаясь 5-секундного полла.

Тесты той же итерацией: `test/integration/runs-cancel-all.spec.ts`
(queued+running флипаются, awaiting_human/terminal/чужой workspace — нет,
finished_at проставлен, идемпотентность, 404) + 2 кейса в
`runs-table.spec.ts` (запрос уходит ТОЛЬКО после подтверждения; dismiss —
ничего не шлёт).

## Iteration 27 — Multi-repository runs (feature 019, 2026-07-18)

Прогон теперь готовит worktree на КАЖДЫЙ репозиторий из scope'а агента:
`behavior.repositories: string[]` (подмножество workspace-репо; пусто/absent =
ВСЕ), deprecated `behavior.repository` жив как одноэлементная форма (при обоих
полях выигрывает список; хранимые строки не переписываются). Layout —
`worktreeRoot/<runId>/<repo.name>/`, cwd агента = родитель, `runs.worktree_path`
указывает на родителя, `.brigadir/wrapper.txt` — вне любого git-дерева. Одна
ветка `<branch_prefix>/<ticketKey>` во всех репо; leftover-политика — по
каждому репо, без изменений; partial failure на N-м репо откатывает уже
созданные worktree и родителя (никаких осиротевших директорий). Resume:
attach где ветка есть, создание где нет (расширение scope между попытками не
брикает awaiting_human). Setup-прогоны сохранили одноэлементный scope (D5).

ReportSchema v2: `schema_version: 1|2` (union, без связки «версия⇄поле» —
v1-отчёты валидны навсегда), `artifacts.repos[]` ({repo, branch, pr_url,
commits, files_changed}, max 20). Прецедентность плоской и plural-форм — ровно
одна реализация `normalizeReportArtifacts` (contracts), её используют: скраббер
(artifacts ОБЕИХ форм теперь скрабятся — закрыт пробел Constitution V),
review-task (N PR → ОДНА review-задача со списком `<repo>: <url>`; один PR —
байт-в-байт прежний заголовок), ADF-коммент и run card (артефакт-строки —
net-new рендеринг: до 019 artifacts не показывались нигде), feature-context
(по-репные branch:/PR: строки). Обёртка: секция `## Repositories` (путь/ветка/
база каждого репо + правила a-d из FR-013, чеки только в изменённых репо);
no-repo обёртка байт-идентична. Валидация имён scope'а на обоих write-путях:
yaml superRefine (per-entry path) и agents controller (400, закрыт и старый
пробел с опечаткой в `repository` через API). Executor-level yaml `repository`
стал optional (runtime игнорирует с 2026-07-13). Web: мульти-селект
Repositories в AgentForm (легаси-строка сидится одноэлементно, сейв переводит
агента на plural), блок Artifacts на RunCard. Схема БД не менялась (scope в
`agents.behavior` jsonb, отчёт в `runs.report` jsonb).

Сознательное изменение поведения (D1): агент БЕЗ repo-полей раньше получал
дефолтный (первый) репозиторий, теперь — ВСЕ репозитории воркспейса (в
одно-репном воркспейсе идентично; интеграционный кейс «absent → default»
переписан на «absent → all»).

Тесты той же итерацией: contracts (v2/repos/normalizer/scope-валидация),
worktree.spec (multi-repo layout, partial-failure unwind, per-repo leftover,
resume-fallback), pick-repository (list-семантика), wrapper (Repositories
секция, no-repo байт-идентичность), executor (parent worktree_path, cwd,
однoэлементный setup-scope), callback unit+integration (скраб обеих форм,
review fan-in), adf-composer снапшоты, agent-crud (422 c per-entry path),
web agent-form (мульти-селект) и run-card (Artifacts); интеграционные:
claude-cli-repository расширен (мульти-репо клоны, одна ветка в обоих кэшах,
subset, unknown-name, отчёт v2 round-trip через фикстуру
stream-success-multi-repo), callback-completion (легаси v1+flat E2E).
Docs: architecture §6 (repos[] + enum [1,2]), §7 (repositories +
Repositories-секция обёртки), §8 (RunRuntime.prepare(repos[])).

Gates green locally: typecheck, lint, unit 296+14 (root+contracts pipeline),
web 256 (30 files), интеграционные 324/326 (81 файл; dockerd с
`--registry-mirror=https://mirror.gcr.io`, как в итерации 18). Два падения —
`runs-cancel-all.spec.ts` (итерация 26), ПРЕДСУЩЕСТВУЮЩИЕ: воспроизводятся на
чистом дереве без изменений 019 (проверено git stash), к фиче отношения не
имеют — окружение/флейк bulk-stop, разбирать отдельной итерацией.

## Iteration 28 — Per-ticket repository scoping через Jira Components (feature 020, 2026-07-18)

Scope прогона стал ПО-ТИКЕТНЫМ: Components тикета пересекаются с базовым
scope'ом агента (base = `behavior.repositories` > deprecated `repository` >
все workspace-репо), и клонируется/монтируется только пересечение (D1 —
intersection, never widen). Не-репозиторные компоненты («Design», «QA»)
отфильтровываются молча (D3 — тикетные имена НЕ ходят через fail-loud ветку
`pickWorkspaceRepositories`). Неопределимый scope — fail-CLOSED парковка в
human queue (D2) с ТРЕМЯ различимыми вопросами: нет Components / ни один не
мапится на репо / пересечение с scope'ом агента пусто (routing-дефект). Гейт
пропускается при одноэлементном base set (D2a) и выключен по умолчанию:
per-workspace флаг `settings.ticket_scoping` (D2b, jsonb, без DDL; OFF =
байт-в-байт поведение 019 — components вообще не читаются в решение). Setup-
прогоны не тронуты (D5). Escape hatch (D4): обёртка суженного прогона
перечисляет исключённые репо (name + git URL) с нотой «клонируй в
`.repos/<name>` по необходимости» — тот же приём, что в setup-протоколе;
несуженная обёртка байт-идентична.

Проводка: `getIssue` теперь тянет `components` (одним запросом с
summary/description), `TicketDetail`/`RunContext.ticket` несут
`components: string[] | null` — `null` = Jira-fетч упал (R5: при активном
гейте прогон честно падает `failed`, НЕ паркуется с неверным вопросом и НЕ
клонирует всё). Чистый резолвер `narrowByTicketComponents()`
(`scope-ticket.ts`, decision table на 10 строк в
contracts/scope-resolution.md; матчинг trim + case-insensitive, FR-016) +
`composeScopeQuestion()` (system-composed тексты только из ключа тикета и
имён — прецедент feature 010, скраббер не нужен). Вставка гейта — в
`resolveClaudeCliConfig` ДО prepareAll (парковка не стоит ни одного клона);
`undeterminable` → типизированный `RepositoryScopeUndeterminableError`,
который processor ловит ДО generic-crashed маппинга и отдаёт в
`HumanTaskService.createFromRequest` (guarded park `running`→`awaiting_human`,
дедуп открытых задач, Jira blocked-transition + коммент через per-issue
queue; правило 7 соблюдено конструктивно — при неудачной парковке fallback в
crashed, где finalize-гварды no-op). В worker `HumanTaskService` заведён
ПРЯМЫМ провайдером (не HumanTasksModule: модуль тащит ResolveController +
fail-fast dashboard-token, которых у worker'а нет в env). Resume-петля
закрыта существующим ResumeService: resolve → superseded + новый queued-прогон
перечитывает Components с нуля. Observability (FR-015): один run_event
`type:'log'` `{source:'repo-scoping', message, components/matched/ignored/
effective/gate}` на каждое scoping-активное разрешение (gate: passed |
skipped_single_repo | parked:<case> | failed:components_unreadable);
presenter таймлайна рендерит его как «Repository scoping» с композитным
сообщением. API/UI: `ticket_scoping` в WorkspaceSettingsRequest/Response
(additive) + инлайновый el-switch на вкладке Settings (паттерн enable/pause
из feature 006). Схема БД не менялась.

Тесты той же итерацией: scope-ticket.spec (17: вся decision table, тексты
вопросов, error-класс), executor.spec (+7: narrowing на call site, typed
throw до prepareAll, флаг OFF без событий, D2a, FR-014 bypass, D5 setup при
включённом флаге), wrapper.spec (+2: escape hatch, байт-идентичность),
jira-client (+components маппинг/поля), dashboard.schema (+ticket_scoping),
web presenter (+repo-scoping рендер) и workspace-settings (switch вне
запрета на инпуты); интеграционные: НОВЫЙ claude-cli-scoping.spec (13:
subset-клоны, silent ignore, never-widen, unscoped-агент, три парковки с
различимыми текстами + zero clone work + rule-7, unreadable→failed,
park→setComponents→resolve→rescope round trip через реальный resolve-эндпоинт,
flag-OFF матрица + двух-workspace изоляция, D2a×2), workspace-settings-rotate
(+round-trip/merge-patch/strict флага). mock-jira научился components
(seedIssue/setComponents/GET issue).

Gates green locally: typecheck (root+contracts+mcp-server+admin-mcp+web
vue-tsc), lint, unit 297→322 root + 161 contracts, web 257 (30 файлов);
интеграционные 337/340 (82 файла). Три падения в двух файлах —
`runs-cancel-all.spec.ts` (задокументированный пре-существующий флейк
итерации 26/27) и `serve-static.spec.ts` — ПРЕДСУЩЕСТВУЮЩИЕ: воспроизведены
на чистом дереве без изменений 020 (git stash -u, идентичные 3 падения),
к фиче отношения не имеют.

## Iteration 29 — Sprint sequencing: порядок исполнения blocked-by-цепочек (feature 022, 2026-07-18)

- **Status**: ✅ Code complete — интеграционные прогоны в CI (в среде разработки не было Docker; юниты/typecheck/lint зелёные локально).
- **Spec**: `specs/022-sprint-sequencing/` (022 — номер 021 зарезервирован за cross-project knowledge reading)
- **Branch**: `claude/sprint-sequencing-blocked-by-natxlb`

Ключевая коррекция вводной (research R1): pull-механизм разблокировки, который
бриф считал отсутствующим, УЖЕ существовал — `ReconcileService.
reEvaluateDependencies` (FR-036 фичи 001, покрыт T066/SC-010). Фича его не
переписывает, а достраивает вокруг него недостающее.

Что вошло: (1) детерминированный порядок волны — `priority` в POLL_FIELDS,
`tickets.priority_id/priority_name` (кэш; миграция 0008 + REVIEW-0008 +
синхронный апдейт architecture.md §3 по правилу 5), канонический компаратор
priority_id ASC NULLS LAST → jira_key ASC в release-цикле и в SQL дашборда;
(2) персистентное waiting-состояние — `tickets.blocked_by/blocked_state`
(diff-кэш, принцип I), пишется на blocked-skip в pipeline и обновляется каждым
release-проходом; (3) фастпас FR-003 — `DependencyReleaseService`
(извлечён в libs/pipeline; scope-jql.ts переехал в libs/jira против цикла
импортов) с `releaseDependentsOf(blocked_by @> key)`, вызывается небезусловно-
нефатально из onWorkerFinished после transition в status_success — цепочка
A→B→C проходит сама без единого reconcile-прохода; (4) диагностика —
классификация cycle > out_of_scope > dead_end > waiting двумя батчевыми
пробами (blocker fetch status+resolution без project-клаузы; scope-проба =
scope JQL воркспейса, key in внутри скобок scope_jql, БЕЗ since),
`findCycleTickets` (итеративный трёхцветный DFS, self-links); out_of_scope
дополнительно поднимает ОДНУ run-less human task на тикет
(`createTicketBlocked`, run_id NULL — колонка nullable с 011; пере-создаётся,
если задачу закрыли без починки борды); (5) видимость — `GET /api/workspaces/
:id/waiting` (конверт фабрики пагинации, канонический ORDER BY) + вкладка
Waiting в workspace (state-теги el-tag, общий ListPagination, placeholderData).

Тесты той же итерацией: юниты priority.spec (4), dependency-release.spec
(компаратор 4 + циклы 5); интеграционные: dependency-gate.spec расширен
waiting-кэш-ассертами (T057/T066 без изменений), НОВЫЙ sprint-sequencing.spec
(цепочка E2E c нулём reconcile-проходов + дедуп + порядок; kill-switch
фастпаса через arm500OnNextSearch → финализация цела, следующий проход
доносит; волна приоритетов ×10 повторов; цикл; dead-end vs done-category
control; out-of-scope: одна задача, дедуп, re-create, board-fix), НОВЫЙ
waiting-endpoint.spec (конверт/порядок/drain/пагинация/404). mock-jira:
priority/resolution в выдаче, project-клауза как key-prefix match,
removeBlockedByLink, arm500OnNextSearch.

Отложено решением clarify 2026-07-18: кап конкурентных прогонов на
цепочку/эпик (кандидат — пер-агентный лимит активных прогонов, который заодно
сериализует цепочки) — отдельной фичей при необходимости.

## Iteration 30 — Самолечение кэша репозиториев (инцидент ST3-780, 2026-07-18)

- **Status**: ✅ Done — typecheck/lint/юниты зелёные (339 тестов, 42 файла).
- **Spec**: нет (баг-фикс по живому инциденту, не фича)
- **Branch**: `claude/agents-st3-780-failure-83a16d`

Инцидент: все прогоны воркспейса ST3 по ST3-780 падали до старта агента с
`repo "st3_agentic": git fetch origin failed: fatal: not a git repository`.
Планировщик (Phileas Fogg, attempt 2) упал за 24 с → триаж увёл тикет в
Blocked; оркестратор (Brigadir, attempt 5) упал за 80 с. Ни одного check,
artifact или потраченного цента — агенты до кода не дошли.

Причина: кэш-клон жил в `os.tmpdir()`, а macOS периодически удаляет из
`$TMPDIR` ФАЙЛЫ старше ~3 дней, оставляя ДИРЕКТОРИИ. От репозитория остался
скелет: `.git/` на месте, `HEAD` и рефы удалены, в `objects/` уцелело 233
файла. Проверка `existsSync(join(cacheDir, '.git'))` отвечала на вопрос «было
ли склонировано?», читала скелет как «да», уходила в ветку `fetch` и падала —
и так на КАЖДОМ ретрае, вечно, потому что ветку `clone` уже ничто не
пересматривало. Соседние `st3_os`/`st3_os_frontend` выжили только потому, что
их трогали накануне.

Что вошло: (1) `ensureCache` спрашивает «примет ли это git?»
(`git rev-parse --git-dir`) вместо «существует ли путь?» — гнилой кэш сносится
и клонируется заново; (2) провал `fetch` НАМЕРЕННО не считается гнилью — это
обычно сеть или SSH-доступ, где снос живого кэша стоит полного клона и ничего
не чинит (клону нужна та же сеть); сносим только если следом не резолвится
`HEAD` (частично выеденный object store — та же гниль другим путём), иначе
ошибка уходит наверх оператору; (3) дефолты `repoCacheRoot`/`worktreeRoot`
переехали из `os.tmpdir()` в `~/.brigadir/` — оба корня держат состояние,
которое переживает прогон (кэш между прогонами; при `keepFailedWorktrees` —
дерево упавшего прогона на дни разбора). Публичные сигнатуры `prepareAll`/
`cleanupAll` не изменились, `claude-cli.executor.ts` не тронут.

Уборка за агентами при этом работала штатно и к инциденту отношения не имеет:
`cleanupWorkspace` висит на завершении процесса (а не на репорте агента —
иначе агент, упавший без репорта, оставлял бы мусор навсегда) и вызывается на
всех терминальных путях; каталог worktree на момент разбора был пуст.

Тесты той же итерацией — новый describe «cache self-healing» в worktree.spec
(3): выпотрошенный reaper'ом `HEAD` → переклонировали (точная репродукция
инцидента); `fetch` упал И `HEAD` не резолвится → переклонировали; `fetch`
упал при ЗДОРОВОМ кэше → ошибка проброшена, кэш НЕ снесён. Первые два
проверены на падение против старого кода, третий — страж против чрезмерно
агрессивного сноса в новой логике. Несущий тест «второй прогон переиспользует
кэш (fetch, не re-clone)» оставлен без правок как ловушка на регрессию
«теперь клонируем всегда». Ассерты дефолтов в claude-cli.config.spec обновлены
под `~/.brigadir`.

Операционные следствия: битые каталоги `st3_agentic` и реликтовый `st3 agentic`
(старое имя репы, с пробелом) снесены руками до фикса — воркспейс
разблокирован. Живые кэши в `$TMPDIR` осиротеют после смены дефолта, первый
прогон каждой репы переклонирует в новое место (7.9M/4.9M — секунды).
ST3-780 остаётся в Blocked: статус в Jira возвращается человеком.

## Iteration 31 — Передача ветки между стадиями пайплайна (feature 023, 2026-07-18)

- **Status**: ✅ Complete — все гейты зелёные локально, включая интеграционные.
- **Spec**: `specs/023-branch-handoff/`
- **Branch**: `claude/reviewer-agent-failure-aea7e1`

Продолжение разбора ST3-780. Итерация 30 починила гниющий кэш репозиториев, после
чего прогон дошёл до планера и разработчика — и упал на ревьюере:
`repo "st3_agentic": branch "run/ST3-780" already exists with 2 commit(s) of prior
work`. Это оказался не флак, а систематическая дыра: **первая стадия, которая
коммитит в run-ветку, проходит; любая следующая падает всегда.**

Механика поломки. Система заранее создавала ветку `<branch_prefix>/<ticket_key>` на
каждый прогон и охраняла её (гард из инцидента 2026-07-14 — не выбрасывать чужую
работу). Право переиспользовать выдавалось по ОДНОМУ признаку: источник триггера
`human-resume|rework`. Обычная передача стадии приходит от поллера (`poll`), то есть
для гарда ревьюер выглядел как «кто-то начинает тикет с нуля». Планер на ST3-780
уцелел случайно: spec-kit увёл его на собственную ветку `016-st3-780-…`, которую
разработчик смержил руками — цепочка держалась на инструкции агенту, не на механике.

Решение (реш. 2026-07-18): **система выходит из неймспейса веток целиком.** Агент и
так сам коммитит и пушит (в коде нет ни одного `git commit`/`push`) и так же сам
отчитывается веткой в `artifacts.repos[].branch`. Теперь система читает этот отчёт и
стартует следующую стадию с заявленной ветки. Конвенция именования заменена явной
записанной передачей. Что изменилось: (1) worktree чекаутится DETACHED на резолвнутом
старт-рефе, `prepareAll` потерял `ticketKey`/`branchPrefix`/`reuseBranch` и получил
`continueBranches` по имени репо, `MultiPrepareResult.branch` удалён (репо расходятся
независимо — общее поле стало структурной ложью); (2) новый `prior-work.ts` —
`failing_run_id` (без фильтра по статусу; ничего не заявил — проваливаемся дальше) →
последний `succeeded` прогон тикета (окно 5) → дефолтная ветка; (3) обёртка объясняет
detached HEAD, `git switch -C` до первого коммита, continue-ветку и то, что следующая
стадия стартует с заявленной ветки; (4) `isResumedAttempt` удалён из `RunContext` —
инференс «продолжение» по источнику триггера и есть первопричина, оставлять поле как
no-op значило бы зарядить те же грабли; (5) событие `run_events` `source: 'start-ref'`
по каждому смонтированному репо, пишется и для скучного `default_branch`.

Две вещи, на которых держится безопасность. Первая — асимметрия: ветка, ЯВНО названная
отчётом и не найденная на origin, роняет прогон громко и НЕ откатывается на `main`
(иначе ревьюер тихо отревьюит пустой диф и вернёт success — худший исход в автономном
пайплайне); отсутствие записи для репо — штатный старт с дефолтной ветки. Вторая —
`git fetch --prune` в `ensureCache` стал несущим, а не гигиеной: без него удалённая на
origin ветка живёт в `refs/remotes/*` вечно и прогон молча стартует с протухшего типа.
Оба свойства пинятся отдельными тестами.

Ретирован fail-loud leftover-гард (инцидент 2026-07-14). Свойство «прогон не
выбрасывает неучтённые коммиты» не компенсировано — оно стало структурно
недостижимым: `git branch -D` ушёл из кодовой базы, пути, способного потерять работу,
больше нет; «молчаливое переиспользование» стало явным и записанным.

Интеграционные сьюты 019/020 использовали «осталась ли в кэше ветка `run/<ticket>`»
как признак «был ли репо смонтирован» — сигнал, который фича убирает. Заменено на
чтение `start-ref` событий: это прямая пер-прогонная запись, а не вывод по кэшу,
живущему между тестами.

Осознанно НЕ сделано (главный остаточный риск): детерминированной проверки «агент
закоммитил, но не отчитался» нет. Если разработчик запушил, но вернул пустые
`artifacts`, ревьюер стартует с `main`, ничего не найдёт и вернёт success — та же
ложно-успешная развилка, но с парадного входа. Лекарство дешёвое (сравнить
`git rev-parse HEAD` со старт-рефом перед cleanup) и описано в
`specs/023-branch-handoff/research.md` → «Deferred». Также отложены: таблица
`run_repo_artifacts` и различение «ветка смержена» vs «пропала», discovery веток через
`ls-remote`, фича-флаг, реапер веток в кэше. Отдельно зафиксирован ПРЕДСУЩЕСТВУЮЩИЙ
баг: `handoff.ts` читает только плоскую v1-форму артефактов, поэтому v2-отчёты не
рендерят строку `Continue on:` вообще.

Gates green locally: typecheck (root+contracts+mcp-server+admin-mcp), lint, unit
353/353 (43 файла, +9 новых в `prior-work.spec.ts`, worktree-сьюта переписана).
Интеграционные 347/353 (85 файлов). Шесть падений в четырёх файлах
(`runs-cancel-all`, `serve-static`, `dependency-gate`, `sprint-sequencing`) —
ПРЕДСУЩЕСТВУЮЩИЕ: воспроизведены на чистом дереве (`git stash -u`, те же 4 файла, те
же 6 падений); `callback-completion` упал один раз под полной нагрузкой и проходит
изолированно — тот же нагрузочный флейк, что задокументирован в итерации 28. Новая
сьюта `claude-cli-branch-handoff.spec.ts` прогнана против ДО-изменения дерева и падает
всеми тремя кейсами, включая молчаливый: заявленная-но-отсутствующая ветка давала
`succeeded` вместо `failed`, то есть прогон стартовал с `main` и отчитался успехом.

ST3-780 разблокируется перезапуском ревьюера уже на новой механике: ветка
`run/ST3-780` запушена на origin, работа разработчика в сохранности, руками трогать
ничего не нужно.

## Iteration 32 — Follow-up к передаче ветки: v2-handoff, снятие suggestion, completion-gate (feature 024, 2026-07-19)

Три хвоста после feature 023 (спека — `specs/024-branch-handoff-followup/`), тремя
user story по приоритету.

**US1 (P1, живой баг).** Секции handoff (`libs/pipeline/src/handoff.ts`,
`failureLines` для triage/answer-triage и `buildReworkSection` для rework) читали
только плоские v1-поля `artifacts.branch`/`pr_url` и обходили
`normalizeReportArtifacts` — единственную реализацию precedence (feature 019). Агенты
этого воркспейса репортят v2 (`artifacts.repos[]`), поэтому rework/triage-агент НЕ
получал строки «Continue on: …»/«Artifacts: …» вообще — не знал, где лежит код.
Оба места пущены через нормализатор: v2 рендерит блок с одной строкой на репо, v1
(один нормализованный элемент без `repo`) — прежнюю однострочную форму байт-в-байт
(старые ассерты не тронуты). Forward-compat v1 сохранён навсегда.

**US2 (P2).** 023 перестал СОЗДАВАТЬ ветки, но продолжал ИМЕНОВАТЬ их: первой стадии
обёртка предлагала `run/<TICKET>` (хардкод `behavior.branch_prefix ?? 'run'` — никто
не выбирал `run/*`), что конфликтовало со spec-kit-конвенцией планировщика
(`016-st3-780-…`). По решению оператора (вариант a) suggestion убран целиком:
удалены `WrapperRepoInfo.suggestedBranch`, `setupRunBranchIdentity`, дефолт `'run'`;
обёртка теперь говорит «заведи ветку своего выбора и заявь её». `branch_prefix`
оставлен инертным хранимым полем в схемах/API/UI (миграций не потребовалось) —
интеграционные фикстуры с ним теперь доказывают инертность.

**US3 (P3) — completion-gate, крупнейший остаточный риск 023.** «Агент закоммитил, но
не заявил ветку» → следующая стадия тихо стартует с дефолтной ветки и репортит
success на пустом дифе. Набросок 023 («сравнить HEAD перед `cleanupWorkspace`,
зафейлить прогон») оказался НЕ контролем: `complete_task` финализирует прогон и ставит
Jira-transition в очередь ДО выхода процесса (`callback.service.ts`), поэтому к exit-
проверке прогон уже `succeeded`, а гвард правила 7 (`WHERE status='running'`) сделал
бы fail no-op'ом. Правильное место — сам `complete_task` (оператор подтвердил):
- executor резолвит `RepoStart.startSha` при подготовке; событие `start-ref` пишется
  ПОСЛЕ `prepareAll` и несёт `startSha` (база гейта); `BRIGADIR_REPO_DIRS`
  (repo→worktree-dir) доставляется в 0600 env-блоке tool-сервера (Принцип V).
- mcp-сервер на `complete_task` снимает `git rev-parse HEAD` по каждому воркти
  (инъектируемо для тестов; репо с ошибкой rev-parse опускается) и шлёт заголовок
  `x-brigadir-observed-heads` (тело POST — неизменный `ReportSchema.strict()`;
  заголовок ставит сам tool-сервер, вне input-схемы тулзы).
- бэкенд (`libs/callback/src/completion-gate.ts` — чистая функция + парсер заголовка,
  плюс гейт в `callback.service.ts` ДО финализации) сравнивает наблюдённые HEAD со
  `startSha` точным неравенством; репо сдвинулся И отчёт не называет для него ветку
  (`normalizeReportArtifacts`, v1-плоский атрибутируется единственному репо) ⇒
  отклонение как validation-failure (прогон остаётся `running`, агент чинит и
  повторяет — как невалидный team-отчёт) + событие `handoff-violation`. Молчит при
  отсутствии доказательств (нет заголовка/`start-ref`-базы/наблюдения репо).
  Неисправленное нарушение приходит к `failed` штатным fail-closed путём — ложный
  success невозможен по построению.

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (376 юнитов, +23 к
baseline 353; mcp-server 17). **`pnpm test:integration` НЕ запускался** — в облачной
сессии не было Docker-демона (прецедент итерации 29). Интеграционный тест гейта
написан (`test/integration/completion-gate.spec.ts`, reject→correct→accept + read-only
+ honest happy-path; фейковый CLI дополнен наблюдением HEAD как у mcp-сервера и шагом
`commit`), но выполняется только на стенде оператора. Также вне скоупа остаются 6
предсуществующих интеграционных фейлов (`runs-cancel-all`, `serve-static`,
`dependency-gate`, `sprint-sequencing`, флейк `callback-completion`) — они старше 023.
Напоминание оператору: пересборка `dist/` не влияет на уже запущенный node-процесс —
после деплоя рестартовать worker и backend.

## Iteration 33 — First-class `kimi` executor type (Moonshot AI backend, feature 025, 2026-07-19)

Второй модель-провайдер для pipeline-агентов: модели Moonshot Kimi (`kimi-k3`,
варианты `kimi-k2.7`) как альтернатива Anthropic. Moonshot отдаёт Anthropic-
совместимый endpoint (`https://api.moonshot.ai/anthropic`), который Claude Code CLI
поддерживает нативно через `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` — правок CLI не
нужно. Реализация: НЕ новый адаптер, а существующий боевой Claude CLI harness
(`libs/executors/src/claude-cli/`), параметризованный provider-пресетом.

**Почему first-class тип, а не поле `provider` в конфиге claude_cli.** Атрибуция
провайдера обязана жить на денормализованной иммутабельной колонке
`runs.executor_type` (`WHERE executor_type = 'kimi'` для аналитики, правка профиля не
переатрибутирует историю). Поле в мутабельном `executors.config` jsonb тихо
переписало бы историю прогонов при редактировании профиля. Нативный `kimi-cli` тоже
отвергнут (нестабильный stream-формат, `config.toml`-генератор вместо env-кредов, нет
Stop-hook аналога для enforcement отчёта) — возможен позже ПОД ТЕМ ЖЕ именем типа: имя
= провайдер, транспорт — деталь реализации.

**Форма реализации (решения, не открытые вопросы).**
- `ClaudeCliExecutor` параметризован конструкторным provider-пресетом
  `{ type, anthropicBaseUrl? }`; `readonly type` берётся из пресета. Две DI-инстанции
  ОДНОГО класса под токеном `AGENT_EXECUTORS`: bare class-provider = `claude_cli`
  (пресет отсутствует → `@Optional` дефолт, поведение байт-в-байт как до 025); вторая
  инстанция под приватным токеном `KIMI_EXECUTOR` через `useFactory` с Moonshot-
  пресетом. `ExecutorRegistry` резолвит по `type` — правок реестра нет.
- Инъекция endpoint'а — чистая `applyProviderEnv(env, preset)` рядом с `applyAuthEnv`,
  строго ПОСЛЕ `buildChildEnv` (allowlist) и после `applyAuthEnv`. Для claude_cli-
  пресета — no-op (env байт-идентичен). `ANTHROPIC_BASE_URL` НИКОГДА не в allowlist:
  host-значение не пройдёт `buildChildEnv` ни для одного типа.
- Auth для kimi неявно api_key-only: в `loadRunConfig` kimi-пресет резолвит
  `{mode:'api_key'}` безусловно и требует sealed-секрет — профиль без ключа падает
  fail-fast штатным failed-путём. Нет auth-селектора, нет host_subscription/bedrock.
- Второй worker-процессор `KimiRunProcessor extends ClaudeCliRunProcessor`, привязан к
  `@Processor(run.kimi)`; общий базовый класс получил `protected executorType`
  (значение claude_cli не изменилось), питающий concurrency-bootstrap/re-apply. Вся
  финализация, гварды правила 7, gate — наследуются verbatim.
- Контракты: `'kimi'` в оба списка `EXECUTOR_TYPES` (interface + contracts) и в
  `RUN_QUEUE_EXECUTOR_TYPES` (провижн `run.kimi` через `QueuesModule`, правок модуля
  очередей нет); `KimiExecutorConfigSchema` (stored camelCase, strict, без auth/aws) в
  union; `KimiExecutorApiConfigSchema` (snake_case, strict, write-only api_key) в
  create-union с рефайнментом «kimi requires an api_key on create» + update-union;
  claude_cli cross-field superRefine-проверки (`repository`, allowedTools) расширены на
  kimi. **Миграций БД нет** (тип — text, config — jsonb; прецедент bedrock 018).
- Backend: маппера `executors.controller` (`toInsertValues`/`toExecutorResponse`,
  `sealApiKey`, update-правило «must end with a key») покрывают `kimi`; для kimi не
  вычисляется `auth`, нигде нет endpoint-поля. **Seed профиля kimi НЕ добавляется**
  (уточнение 2026-07-19): создание только вручную через форму/API, чтобы инвариант
  «ключ обязателен» оставался безусловным.
- Web: `kimi` в селекторе типа `ExecutorForm`; общий с claude_cli набор harness-полей
  через `isCliHarness`; НЕТ auth-селектора, AWS-полей, URL-поля; ключ обязателен на
  create (клиентский гвард), заменяем, но не очищаем (keyless kimi невозможен).
  `cost_usd` kimi-прогонов помечен индикативным маркером `~` с тултипом в `RunCard` и
  таблице `Runs` (CLI считает по прайсу Anthropic, не Moonshot; пересчёт — вне scope).

**Тесты (правило 4, в той же итерации).** Юниты: `applyProviderEnv`-матрица (kimi ⇒
Moonshot-константа; claude_cli ⇒ ключ отсутствует; чистота; host не утекает); реестр/
модуль (обе инстанции, resolve('kimi')); claude_cli env байт-идентичен на всех auth-
модах (регрессия SC-002); allowlist-floor lock (негативный пин через `buildChildEnv`);
контрактные accept/reject матрицы kimi (schema + agents-config). Web: набор полей формы
kimi/валидация/форма запроса/no-clear; индикативный маркер в RunCard. Интеграционные
(testcontainers + fake-claude): `kimi-run` (e2e env-dump, паритет rate-limit/no-report/
keyless, claude_cli-компаньон без base URL, иммутабельная атрибуция), `kimi-security`
(polluted host-shell + argv), `kimi-executor-crud` (API-матрица ошибок), `kimi-gate`
(type capacity + per-profile limit).

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (unit 387, +4 к baseline
383; contracts/mcp/admin отдельными проектами зелёные; web 266, +8). **`pnpm
test:integration` НЕ запускался** — в облачной сессии нет Docker-демона (прецедент
итераций 29/32); 4 новых kimi-интеграционных сьюта написаны, выполняются на стенде
оператора. Пред­существующие интеграционные фейлы старше 025 — вне скоупа. Напоминание:
пересборка `dist/` не влияет на запущенный node-процесс — после деплоя рестартовать
worker и backend; для admin-MCP также нужен `pnpm --filter @brigadir/admin-mcp build`.

**Ревью-проход (после смены модели на середине US5).** Независимый адверсариал-ревью
диффа нашёл один реальный дефект (web-слой, граница модели): маркер индикативной
стоимости в таблице Runs гейтился по `row.executor_type === 'kimi'`, но
`RunListItemSchema` (`.strict()`) поля `executor_type` не имел и list-контроллер его не
мапил — маркер жил только на карточке прогона. Починено: поле добавлено в схему И в
select/map контроллера (оба слоя двигаются вместе из-за `.strict()`), плюс
регресс-тест `runs-table.spec.ts` на присутствие/отсутствие маркера. Остальное ревью
подтвердило корректным: DI-регистрация двух инстанций, привязка субкласса-процессора к
`run.kimi` (own-метаданные затеняют родителя, `@nestjs/bullmq@11.0.4`), порядок
инъекции env и floor-инвариант, zod-4 discriminatedUnion+superRefine, контроллерные
правила ключа. Косметика: в списке executors тег `kimi` теперь читается как реальный
бэкенд (primary), а не как fake `mock` (info).

## Iteration 34 — Инцидент 2026-07-19, Фаза 2: rate_limit больше не превращается в timed_out (Problem 3)

План: `docs/incident-2026-07-19-fix-plan.md` (Фаза 2). Фаза 1 (P0, MCP-callback,
Problems 1–2) уже влита коммитом `8c12942`; отдельный kimi-429 TTL-фикс
(`sanitizeRateLimitTtl`, `035ada8`) тоже. Эта итерация закрывает Problem 3.

**Найденная первопричина (её НЕ было в исходном fix-plan).** `Captain Nemo` на
`claude-opus-4-8` поймал `api_retry: rate_limit`, executor вызвал `terminate()`, но
прогон висел ~50 мин до watchdog-таймаута и финализировался как `timed_out` вместо
`rate_limited` (сжёг попытку вместо park+requeue). Корень — порядок веток в `handleClose`
(`claude-cli.executor.ts`): `abortReason` проверялся ДО `rateLimited`. Когда `terminate()`
не дожинает группу (escaped-потомок держит pipe-fd → `close` не приходит), промис висит,
пока processor-watchdog не выставит `abortReason='timeout'`; на `close` ветка abortReason
выигрывала → `timed_out`.

**Изменения.**
1. **Порядок исходов в `handleClose`** теперь `cancelled` > `rate_limited` > `timeout`
   (`libs/executors/src/claude-cli/claude-cli.executor.ts`). Cancel по-прежнему
   авторитетен; уже распарсенный rate_limit перебивает ПОЗДНИЙ watchdog-таймаут. Оба
   `cancelled`/`timeout` сохраняют перенос `terminal?.totalCostUsd/usage` (путь cost-
   preservation cancel-поллера — правило D7 — не задет).
2. **Дожинание escaped-потомков в `terminate()`** (`process-group.ts`). После SIGTERM+grace,
   если лидер жив, снимаем снапшот дерева потомков через рекурсивный `pgrep -P` (ПОКА лидер
   жив — после SIGKILL потомки ре파рентятся к init и теряют ppid-связь), затем SIGKILL и по
   группе (`-pid`), и по каждому пережившему pid. `setsid()`-потомок (docker) не в группе,
   держит pipe-fd — из-за него `close` не приходил и слот висел до таймаута. Best-effort,
   не бросает: `pgrep` отсутствует/падает → фолбэк на групповой сигнал; ESRCH проглатывается.
3. **Дефолт/клэмп `killGraceMs`** (`claude-cli.config.ts` + `agents-config.schema.ts`).
   Новый `normalizeKillGraceMs` в `resolveClaudeCliConfig` клэмпит рантайм-значение в
   `[1000, 60000]`, дефолт `10_000` (не-finite/absent). zod-дефолт поднят `5000→10000`, но
   `min(0)` в схеме СОХРАНЁН намеренно: жёсткий floor живёт только в рантайм-нормализаторе,
   чтобы out-of-range значение в stored jsonb клэмпилось, а не валило boot-валидацию.
   `0` раньше значил SIGTERM, тут же добиваемый SIGKILL — без окна graceful-shutdown.
4. **TTL-override processor'а НЕ трогали** (Change 4 плана — отклонён). Явный
   operator/test override в `resolveRateLimitTtl` документирован как «deliberately NOT
   clamped ... exact by construction» и это доверенный вход; санитизация сломала бы
   интеграционные `rate_limit_ttl_ms`-фикстуры с малым точным окном. Регрессия покрыта на
   уровне маппера (`status-mapping.spec.ts`: `rate_limited → {action:'rate_limit'}`) и
   executor'а (новые тесты ниже).

**Тесты (правило 4, в той же итерации).**
- `claude-cli.executor.spec.ts`: репродукция инцидента — `stream-rate-limit` + поздний
  `abort('timeout')` ДО `close` (через `makeGroupNoClose`, чей `terminate` не эмитит
  `close`) ⇒ `rate_limited` (падал до фикса); cancel-после-rate_limit ⇒ `cancelled`.
  Фикстуры `killGraceMs 50→1000`, ассерт `terminate` → `1000`.
- `process-group.spec.ts`: мок `execFile` (pgrep); escaped-внук `9001` получает
  `SIGKILL` по pid + по группе; отказ `pgrep` ⇒ фолбэк без throw, только групповой сигнал.
- `claude-cli.config.spec.ts`: матрица `normalizeKillGraceMs` (in-range/floor/ceiling/
  round/дефолт) + клэмп через `resolveClaudeCliConfig`.
- `agents-config.schema.spec.ts`: дефолт `killGraceMs` обновлён `5000→10000` (обе ветки).
- Интеграционный harness `test/integration/claude-cli-harness.ts`: `killGraceMs 500→1000`
  (иначе клэмпнулся бы рантаймом — держим в синхроне).

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (unit 406;
contracts/mcp/admin отдельными проектами зелёные). **`pnpm test:integration` НЕ
запускался** — в сессии нет Docker (прецедент итераций 29/32/33). БД-миграций нет.
Напоминание: `dist/` контрактов в gitignore — после деплоя пересобрать и рестартовать
worker/backend, чтобы поднялся новый zod-дефолт `killGraceMs`.

## Iteration 35 — Инцидент 2026-07-19, Фаза 3: ограничение QA-стека + stderr на timeout (P1, 2026-07-20)

Две независимые P1-правки из `docs/incident-2026-07-19-fix-plan.md` §Phase 3
(проблемы 4 и 5). Обе — маленькие, самодостаточные, покрыты юнит-тестами в той же
итерации (правило 4). Опираются на реордер `handleClose` из Iteration 34 (Фаза 2).

**Проблема 4 — QA-агент поднимает полный dev-стек внутри прогона.** Cyrus Smith
(ST3-872) прогнал `docker compose`, `npm ci`, `nohup npm run start:dev` и живые
JSON-RPC вызовы, спалив весь 45-минутный бюджет в `timed_out`. В
`libs/executors/src/claude-cli/wrapper.ts` добавлена секция `## Verification and QA`
(новый хелпер `verificationSection()`, стиль как у `callbackToolsSection()`),
рендерится ТОЛЬКО на callback-канале (эскейп-хэтч ссылается на
`mcp__brigadir__request_human(blocking=true)`, которого нет в Phase-0). Правила: не
поднимать полный стек (`docker compose up`, `npm ci`, долгоживущий `start:dev`), если
это >~5 минут; предпочитать unit/integration-тесты и статанализ; если live-тест
критичен — сперва проверить, что сервисы УЖЕ подняты и доступны, иначе не поднимать
самому, а звать человека blocking-запросом. Phase-0 (`useCallbackChannel = false`)
остаётся байт-в-байт (гвардится существующими спеками).

**Проблема 5 — stderr теряется на `timed_out`.** В
`libs/executors/src/claude-cli/claude-cli.executor.ts` (`runProcess` → `handleClose`)
ветка `abortReason === 'timeout'` (реордер `cancelled > rate_limited > timeout` из
Фазы 2) перед `settle` персистит последний ≤16 KB хвост `stderrTail.text` как
`run_event(type='error')` через уже существующий `persistRunEvent` (SC #4 «последние
16 KB»). `StderrTail` уже режет буфер до `STDERR_TAIL_BYTES` на каждом `push`, поэтому
доп. slice не нужен; `type='error'` — документированный валидный тип (`run-events.ts`,
колонка free-form text, без enum), без миграции. `cancelled`/`rate_limited` (ветки выше)
остаются молчаливыми — поведение не меняется.

**Тесты.** `wrapper.spec.ts`: секция QA присутствует на callback-канале и отсутствует
на Phase-0. `claude-cli.executor.spec.ts` (харнесс `FakeChild`/`makeGroup`/
`fakeDb().insertedEvents`, NDJSON-фикстуры): timeout с непустым stderr пишет
`error`-событие с хвостом, усечённым до 16 KB (endsWith последнего чанка, без первого);
cancelled НЕ пишет `error`-событие.

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (unit 410, +4 к
baseline 406 из Iteration 34). `pnpm test:integration` НЕ запускался — в облачной сессии
нет Docker (прецедент итераций 29/32/33/34); для этих двух юнит-уровневых правок
интеграционное покрытие не требуется. Callback HTTP-контракт, Phase-0, схема БД — не
тронуты; новых внешних зависимостей нет.

## Iteration 36 — Инцидент 2026-07-19, Фаза 4: durable finalize / outbox (P2, Problem 6, 2026-07-20)

Последний слой надёжности из `docs/incident-2026-07-19-fix-plan.md` §Phase 4. В инциденте
7 из 8 прогонов упали в `timed_out` с `outcome = NULL`: агент уже сформировал
`complete_task`, но HTTP-callback не доходил до бэкенда (`TypeError: fetch failed`) и отчёт
терялся. Фаза 4 добавляет локальный **outbox**, из которого воркер восстанавливает исход.

**Запись (MCP-сервер).** Новый модуль `packages/mcp-server/src/outbox.ts` (по образцу
`marker.ts`, только node-builtins — пакет держим тонким). В `tools.ts` `complete_task`
пишет отчёт в `<dirname(BRIGADIR_MARKER_PATH)>/.brigadir-outbox/<runId>.json` ПЕРЕД POST и
удаляет его на 2xx. Инвариант: outbox-файл существует ⇔ завершение произошло локально, но НЕ
подтверждено бэкендом. `writeOutbox`/`removeOutbox` — best-effort (никогда не бросают:
завершение не должно падать из-за outbox); `args` не валидированы на MCP-стороне, поэтому
`outcome` читается защитно.

**Реконсиляция (воркер).** Новый `libs/executors/src/claude-cli/outbox.ts`
(`readOutboxReport`/`consumeOutbox`/`outboxFilePath`, `configRoot` = тот же
`defaultMcpConfigRoot(os.tmpdir())`, экспорт добавлен в барель). В
`apps/worker/src/claude-cli-run.processor.ts`, ветка `finalize` для callback-канала, ДО
записи `timed_out` (прогон ещё `running`, поэтому гвард `finalizeWithReport`
`status IN (queued,running,awaiting_human)` проходит штатно): при `decision.status ===
'timed_out'` читаем outbox и, если отчёт есть, финализируем через обычный
`RunsService.finalizeWithReport` — та же валидация / `run_checks` / `human_tasks`, что у
живого callback'а — затем `consumeOutbox`. Только `timed_out`: `cancelled`/`rate_limited` —
намеренные остановки, их нельзя затирать устаревшим локальным отчётом (перекликается с
правилом 7). Битый отчёт (падает `ReportSchema.parse`) или проигранная гонка
(`finalizeWithReport` → false) — проваливаемся в неизменённую ветку `timed_out`, без
двойной финализации. Outbox переживает `WrittenMcpConfig.cleanup` (тот удаляет только
config + `.marker`), поэтому файл ещё на диске в момент финализации; в executor-cleanup его
НЕ трогаем (cleanup идёт до этой ветки). Watchdog из `libs/ingest` (страховка на случай
смерти самого воркера) — задокументированный non-goal этой фазы.

**Тесты.** `packages/mcp-server/src/tools.spec.ts`: network-error `complete_task` оставляет
outbox с корректным JSON (`runId`/`outcome`/`report`/`timestamp`); 2xx удаляет outbox; сбой
записи outbox (`.brigadir-outbox` заранее создан ФАЙЛОМ → mkdir падает, маркер-сосед пишется
штатно) не ломает завершение. Новый `libs/executors/src/claude-cli/outbox.spec.ts`:
`readOutboxReport` отдаёт отчёт / null на missing / битом JSON / несовпадении `runId`;
`consumeOutbox` удаляет и идемпотентен. Проводка процессора покрыта интеграционно (юнит-спеки
у процессора нет — прецедент).

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (unit 416). `pnpm
test:integration` НЕ запускался — в облачной сессии нет Docker (прецедент итераций
29/32/33/34/35). Callback HTTP-контракт, Phase-0 (`useCallbackChannel = false` — вся
реконсиляция внутри callback-ветки), схема БД — не тронуты; миграций нет; новых внешних
зависимостей нет.

## Iteration 37 — Инцидент 2026-07-19, Фаза 5: снижение параллелизма + мониторинг (P2, Problem 7, 2026-07-20)

Последняя фаза `docs/incident-2026-07-19-fix-plan.md` §Phase 5 — инцидент закрыт (Problems
1–7). В пике **10 прогонов исполнялись параллельно на одном хосте**; операторская сумма
`max_parallel_runs` профилей давала type-capacity 22, и ничто не мешало всплеску целиком из
`claude-opus-4-8` занять всю ёмкость типа. Пер-профильный дефолт уже низкий (2), поэтому
рычаги — не понижение хардкода, а **потолок суммарной ёмкости**, **пер-модельный кап** и
**сигнал перегрузки**.

**G1 — потолок type-capacity.** `apps/worker/src/executor-concurrency.ts`: перед
присваиванием `worker.concurrency` сумма кламится опциональным потолком
`typeCapacityCeiling()` — пер-типовой `EXECUTOR_MAX_TYPE_CONCURRENCY_<TYPE>` (тип в верхнем
регистре) старше generic `EXECUTOR_MAX_TYPE_CONCURRENCY`; читается лениво на каждом вызове
(правило #1), значение должно быть целым ≥ 1, иначе игнорируется. Не задано ⇒ прежнее
поведение (чистая сумма). Контракт «тихий no-op при неизменном» сохранён (сравниваем
`effective`), про клам логируем только когда он реально сработал (`effective < total`).

**G2 — пер-модельный кап (реальная защита).** `apps/worker/src/executor-gate.ts`: модель
профиля берётся из `executors.config->>'model'`. Новый `EXECUTOR_MODEL_LIMITS`
(`'{"claude-opus-4-8":2}'`, JSON-карта model→положительное целое, ленивый `parseModelLimits`,
битый JSON / неположительные записи отбрасываются с warn-once на distinct raw) задаёт кап на
число `running` прогонов **по всем профилям с этой моделью** (любого типа —
`runs⋈agents⋈executors WHERE config->>'model' = <model>`). Порядок в гейте: `disabled` →
пер-профиль → пер-модель; модельный запрос выполняется ТОЛЬКО когда у модели есть кап (обычный
безкапный путь — без лишнего запроса). Модели нет в карте ⇒ капа нет. `GateVerdict.reason`
расширен `'model_at_capacity'` (несёт `profile` + `model`), новый `MODEL_AT_CAPACITY_TTL_MS =
1000`, `ttlOverride()` уважается. Решающая логика вынесена в чистую `decideGate(inputs)`
(counts+limits → verdict), `checkExecutorGate` — тонкая DB-оболочка (юниты без Docker,
прецедент облачных сессий). ID модели — данные, не константа.

**G3 — сигнал перегрузки.** На **admit** при post-admit занятости ≥ 75% самого тесного
применимого лимита (профиль всегда; модель — при наличии капа) `decideGate` возвращает
`nearCapacity` (`limitKind` / `running` / `limit`), процессор пишет `logger.warn`. Порог
считаем от post-admit занятости `(running+1)/limit`, а не от pre-admit — при дефолте
`max_parallel_runs = 2` pre-admit-чтение никогда бы не достигло 75% и warn был бы мёртв там,
где лимиты малы. DB-доступ — в гейте, логирование — в процессоре (текущий сплит).

**Проводка.** `apps/worker/src/claude-cli-run.processor.ts`: `model_at_capacity` идёт по той
же rate-limit-паузе (`worker.rateLimit` + `Worker.RateLimitError()`, атаки не сжигаются), в
hold-лог добавлена модель; после `gate.admit` — G3-warn при `nearCapacity`; `this.logger`
прокинут в `checkExecutorGate` (для warn о битом `EXECUTOR_MODEL_LIMITS`). `KimiRunProcessor
extends ClaudeCliRunProcessor` — наследует всё, отдельных правок нет. Mock-процессор
(`run.processor.ts`) вызывает гейт без логгера (параметр опционален) — Phase-0 не затронут.

**Тесты.** `apps/worker/src/executor-gate.spec.ts` (новый, 17): `decideGate` — admit;
disabled(15000); at_capacity(1000); model_at_capacity(1000, с `profile`+`model`); без
`modelLimit` модель игнорируется даже при высоком `modelRunning`; профиль важнее модели при
двойном насыщении; `ttlOverride` на всех трёх причинах; `nearCapacity` — профиль/модель/оба
(побеждает наибольшая утилизация), ниже порога — нет хинта, дефолт 2 на 2-м прогоне
(2/2=100%) срабатывает; `parseModelLimits` — валид/пусто/битый JSON/дроп неположительных.
`executor-concurrency.spec.ts` (+10): клам активен (22→6, лог), не задан → сумма, пер-тип
старше generic, невалид (`0/-1/abc/3.5/''`) игнор, потолок выше суммы не кламит, тихий no-op.
`test/integration/executor-gate.spec.ts` (+1): два `claude_cli`-профиля с общей моделью,
`EXECUTOR_MODEL_LIMITS={model:2}`, 3-й прогон держится (`queued`, `attempt=1`), затем
досдаётся на 1-й попытке.

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (unit 443). `pnpm
test:integration executor-gate` — зелёные (3/3, включая пер-модельный кейс; Docker был
доступен в этой сессии). Схема БД / `architecture.md` §3 / callback HTTP-контракт — не
тронуты; миграций нет; новых внешних зависимостей нет; Phase-0 и mock-исполнитель не
затронуты. Новые env (все опциональные, дефолт = прежнее поведение) задокументированы в
`.env.example`.

## Iteration 38 — Читаемый таймлайн прогона: без JSON-дампов, видно обращения к Бригадиру (feature 026, 2026-07-21)

**Проблема.** Оператор не мог прочитать, что сказал агент: ассистентский текст и `tool_call.input`
резались (`snippetMaxChars=500`, `truncate(JSON.stringify(input))` → неразборный обрезок посреди
JSON, который UI показывал сырым), контрактный кап `report_progress.message` = 500, а обращения
агента к оркестратору (`mcp__brigadir__*`) выглядели как обычные тул-коллы с гаечным ключом.

**Достоверность данных (запись).** Новый чистый `tool-input-sanitizer.ts`: `tool_call.input`
персистится СТРУКТУРНЫМ объектом (не строкой). Политика по имени поля на любой глубине:
человеческий текст (`message/title/details/summary`) — целиком, скраб; файловые тела
(`content/new_string/old_string`) → плейсхолдер `"<file content, N KB>"`; прочие строки — скраб +
кап 2000, флаг `truncated`. **Рекурсия в вложенные объекты/массивы** (`checks[].reason`,
`artifacts.*` у `complete_task`) — каждая вложенная строка проходит скраб (Принцип V; закрывает
находку C1 из `/speckit-analyze`). Парсер больше не режет ассистентский текст, сэмплинг поднят
20→100 строк; `report_progress.message` контракт 500→4000 (reject, не обрезка). Исполнитель
прокидывает реальный `@brigadir/scrubber.scrub`. Схема БД не тронута — `run_events.payload` уже
`jsonb`, изменилась только форма значений; запись в Jira не тронута.

**Презентация (чтение).** Пресентер стал типизированным view-model'ом (`bodyFormat
markdown|mono|kv`, `tags`, `orchestrator`/`iconKey`, `legacyTruncated`/`fieldTruncated`). Выделен
компонент `RunTimeline/TimelineEvent.vue` (имя `RunCard.vue` уже занято детальным вью прогона):
message/details/summary → Markdown через `MarkdownText.vue`, команды/сырьё → моноблок, файловое
тело → плейсхолдер, длинное тело — пер-элементный «Show more/less» (полный текст всегда в DOM —
уточнение решения 2026-07-15, не отмена). Типизированные карточки brigadir-коллов: `request_human`
(заголовок из `title`, теги `kind`+`blocking`, `details` Markdown, иконка MessageCircleQuestion);
`complete_task` («Complete · outcome», `summary` Markdown, тег «N checks», FlagTriangleRight);
`report_progress` («report_progress → Brigadir», Megaphone) — дедуп с progress-событием сохранён.
Структурный payload без текстового поля → компактный key/value список, не JSON-дамп. Все иконки
статичные (правило: hover-анимация только в сайдбаре).

**Тесты.** `tool-input-sanitizer.spec.ts` (новый), расширен `stream-parser.spec.ts` (структурный
payload, полный текст, кап 100, C1-регрессия на вложенных строках), `callback-tools.schema.spec.ts`
(+4000/−4001), `run-timeline-presenter.spec.ts` (форматы тела, orchestrator/карточки/kv, дедуп),
новый `run-timeline-event.spec.ts` (Markdown vs `<pre>`, коллапс, иконки, теги, kv, статичность),
`test/integration/callback-progress.spec.ts` (+4000-символьное сообщение целиком, фиделити
`request_human.details`).

**Гейты.** `pnpm typecheck` + web `vue-tsc` + `pnpm lint` — зелёные; `pnpm test` — unit 458;
web-сьют — 281. `pnpm test:integration callback-progress` — требует Docker (в этой сессии не
запускался; контрактный кап 4000 покрыт юнитом). Схема БД / запись в Jira / дедуп — не тронуты;
миграций и новых внешних зависимостей нет.

## Iteration 39 — Durable finalization v2: deployment guard + рабочая outbox-страховка (feature 026 durable-run-finalization-v2, 2026-07-21)

> Примечание: номер фичи 026 занят двумя параллельными работами — читаемость
> таймлайна (Iteration 38, `specs/026-run-timeline-readability`) и эта
> durable-финализация (`specs/026-durable-run-finalization-v2`). Обе слиты; здесь
> — вторая.

**Контекст.** Пост-мортем прогона `3f60c1a1` (2026-07-20) поверх инцидента
2026-07-19: у callback-финализации нет рабочей страховки. QA-агент вычислил PASS,
15 минут ретраил `complete_task`/`request_human` в мёртвый канал, прогон закрылся
`cancelled` с `outcome=NULL` — вердикт потерян, хотя целиком лежал в outbox. Четыре
независимых дыры: (2) merged≠deployed — воркер спавнит вручную собранный
`dist/main.js`, Phase-4-фикс был смёржен, но dist не пересобран; (3) exit-reconcile
жил только в ветке `timed_out`; (4) нет ретроактивного спасения осиротевших outbox;
(5) нет pre-flight-проверки канала. (Клиентский баг канала — P0/#44, предпосылка.)

**Сделано (4 независимо мержимых среза, все — только callback-wired; Phase-0 байт-в-байт).**
- **A. Deployment guard.** `libs/executors/.../artifact-guard.ts` (+ `mcp-server-path.ts`,
  вынесен из executor'а): артефакт существует и не старше `packages/mcp-server/src/**`
  (mtime). Нарушение — громко: на старте воркера error-баннер (`artifact-guard.bootstrap.ts`,
  воркер стартует), на pickup callback-wired прогона — `failed` с явной ошибкой ДО спавна
  (Clarification Q1, гибрид). Мемо 10 c ⇒ ребилд лечит без рестарта. `start:worker` и
  `test:integration` теперь собирают mcp-server первым шагом (Docker-образ уже собирал).
- **B. Exit-time reconcile расширен** (`claude-cli-run.processor.ts`): ветка `completed`-exit
  до fail-closed читает outbox → валидный отчёт финализирует штатным `finalizeWithReport`
  (+ скраб, как живой callback); `timed_out` — как раньше, но теперь ТОЖЕ скрабит (закрыт
  пробел Принципа V); `cancelled` — статус не трогаем, отчёт цепляем событием
  `undelivered_report`, файл консьюмим; невалидный файл сохраняем (FR-007).
- **C. Периодический реконсайлер** (`OutboxReconcileService/Processor/Scheduler`,
  `every: 60_000`, идемпотентен по id): скан `<configRoot>/.brigadir-outbox/*.json`,
  решение по текущему статусу (Принцип I). `RunsService.reconcileWithReport` — расширенный
  guard `active OR (failed/timed_out AND outcome IS NULL)`, гонка с живым callback
  безопасна (flipped). `cancelled`/`superseded` → `undelivered_report`; `awaiting_human` →
  skip+keep; неизвестный/финализированный → консьюм; неразрешимые (битые, не-UUID) →
  ретеншн 7 дней. `resolveMcpConfigRoot()` (env `BRIGADIR_MCP_CONFIG_ROOT`) — один источник
  правды для писателя и всех читателей.
- **D. Pre-flight probe** (`channel-probe.ts` + `GET /api/callbacks/health`, аддитивный,
  без гарда): проба перед спавном; мёртвый канал ⇒ hold через `worker.rateLimit`
  (попытка не жжётся, статус `queued`), backoff 30 c·2ⁿ cap 5 мин, событие `channel_down`,
  при ≥3 подряд — error-алерт (Clarification Q3, переиспользование hold-пути). Защищает от
  environment-outage (класс 2026-07-19), не от client-багов/смерти посреди прогона.
- Скрабинг вынесен в `libs/callback/report-scrub.ts` (`scrubAgentReport`) — единая точка
  аудита Принципа V для живого callback И всех reconcile-путей. Дашборд: `RunTimeline`
  рендерит `undelivered_report`/`channel_down` (неизвестные типы деградируют в generic).

**Тесты.** Юниты (+16): `artifact-guard.spec` (missing/stale/fresh/no-src/memo),
`outbox.spec` (+listOutboxEntries), `channel-probe.spec` (ladder/reset/threshold/url),
`callback-health.controller.spec` (200/без гарда/без deps), `queues.module.spec` (+outbox-queue).
Интеграционные (real PG/Redis, +12): `artifact-guard` (stale→failed / Phase-0 не затронут /
heal без рестарта), `claude-cli-exit-reconcile` (completed-rescue / invalid→fail-closed+файл /
cancelled→undelivered), `outbox-reconcile` (матрица / гонка-no-op / ретеншн / один шедулер),
`preflight-channel` (down→hold без спавна и без попытки → recovery / mock не пробит).

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test` — зелёные (unit 459). `pnpm exec vitest
run --project integration` по срезам feature-026 — 12/12 зелёные (Docker доступен). Схема БД /
`architecture.md` §3 — не тронуты (миграций нет; `run_events.type` — свободный text, оба новых
типа аддитивны); callback HTTP-контракт существующих тулз — не тронут (`/health` аддитивен);
новых внешних зависимостей нет. Предвестники не из feature 026 (`serve-static`,
`sprint-sequencing`, `runs-cancel-all`, `dependency-gate`) падают идентично на чистой базе
(окруженческое: web не собран, тайминги Jira-моков) — не регресс. Новые env (все опциональные,
дефолт = прежнее поведение) — в `.env.example`. Отклонения от плана: `superseded` сгруппирован
с `cancelled` (намеренный стоп), джиттер реконсайлера опущен (один воркер) — см.
`research.md` D6.

## Iteration 40 — Санация тестовой базы: 4 красных сьюта + прод-фикс SPA-fallback + веб-гейты (2026-07-21)

**Контекст.** Полный `pnpm test:integration` никогда не был зелёным: 4 сьюта падали и на
чистом main (доказано стэшем). Диагностика до строк показала: три — баги самих тестов
(писались без прогона под Docker), четвёртый вскрыл настоящий прод-баг. Плюс веб-проверки
падали на свежем чекауте 45 фантомными ошибками из-за протухшего `packages/contracts/dist`.

**Сделано.**
- `runs-cancel-all.spec`: хелпер вставлял несколько АКТИВНЫХ прогонов на одну пару
  (ticket, agent) — ловил собственный `runs_one_active` (уровень идемпотентности №3).
  Теперь каждый прогон на своём тикете (паттерн `runs-global.spec`).
- `dependency-gate.spec` (reconcile-side): блокер `BLK-*` лежал вне проекта `BRIG` —
  scope-probe корректно давал `out_of_scope` вместо ожидаемого `waiting`. Ключ блокера
  теперь внутрипроектный (`BRIG-9xx`); ветка `out_of_scope` по-прежнему намеренно
  покрыта в `sprint-sequencing` (`OTHER-*`).
- `sprint-sequencing.spec`: (a) chain-тест читал `transitionsFor` сразу после
  `status='succeeded'`, гоняясь с Jira-transition, который прод пишет ПОСЛЕ финализации —
  добавлен `waitFor` на наблюдаемый эффект борды; (b) one-shot 500 взводился ПОСЛЕ
  триггера G и мог пережить fast-path, детонируя на прямом (не обёрнутом в
  `ReconcileService.step()`) вызове `reEvaluateDependencies` — порядок детерминизирован
  (F ждёт → arm → G триггерится) + барьер `mock.search500Armed()` (новый геттер).
- **Прод-баг SPA-fallback** (`serve-static.spec` его и поймал): renderFn
  `ServeStaticModule` зовёт `res.sendFile(<абсолютный путь>, null)` БЕЗ `root`, и
  `send` применяет дефолтную политику `dotfiles:'ignore'` ко ВСЕМ сегментам пути —
  любой чекаут под dot-директорией (git-worktree `.claude/worktrees/…`) получал 404 на
  существующий index.html (статика при этом работала — там root задан). Фикс:
  `SpaFallbackProvider` (`apps/backend/src/spa-fallback.provider.ts`) регистрирует свой
  fallback `res.sendFile('index.html', { root: dist })` на onModuleInit; модульный
  fallback запаркован на несматчащийся `renderPath`. `/api/*` и `/health` не затеняются
  (T145 сохранён).
- **Веб-гейты**: `apps/web` `typecheck`/`test` сами собирают `@brigadir/contracts`
  (bare-импорт резолвится в gitignored `dist`); корневые `typecheck`/`test` теперь
  включают веб (реш. 2026-07-21). CLAUDE.md / docs/local-setup.md обновлены.

**Гейты.** Полный `pnpm test:integration` — впервые целиком зелёный. `pnpm typecheck &&
pnpm lint && pnpm test` (теперь с вебом) — зелёные. Прод-код затронут одной точкой —
SPA-fallback бэкенда; схема БД, контракты, пайплайн — не тронуты.

## Iteration 41 — Устойчивость callback-канала: стабильный режим + worker-lock + breadcrumbs + channel-health (feature 027, 2026-07-21)

Закрывает два оставшихся пробела пост-мортема 2026-07-19/20 (спека
`specs/027-callback-channel-resilience/`, clarify-решения от 2026-07-21).

- **A. Стабильный режим для агент-прогонов** (`scripts/agents-mode.mjs`,
  `pnpm agents:start|stop|status`, docs/local-setup.md §2a): вторая native
  non-watch пара из собранных бандлов на `BRIGADIR_AGENTS_PORT` (3210);
  callback-цель агентов отвязана от dev-стека человека. Guard/probe/outbox —
  идентичны dev-режиму (тот же cwd и configRoot). Живая проверка: пара
  поднята против одноразовых контейнеров, health 200, drain-based stop.
- **A. Эксклюзивный worker-lock** (`worker-lock.service.ts` + bootstrap; все
  процессоры → `autorun: false`): один консьюмер на BullMQ-неймспейс. Контендер
  не потребляет НИЧЕГО и орёт ERROR'ом каждые ~2 c; держатель видит contender-ключ
  и орёт со своей стороны; смерть держателя ⇒ takeover ≤ TTL (15 c). Интеграция:
  `worker-lock.spec.ts` (блокировка, handover, TTL-takeover, изоляция префиксов).
  Живой drill: dev-worker против agents-пары — ERROR ≤ 1 c с обеих сторон.
- **B. Channel-failure breadcrumbs**: tool-сервер пишет summary-строку в
  `<configRoot>/.brigadir-channel/<runId>.jsonl` при исчерпании ЛЮБОГО
  retry-бюджета (network 11 попыток / 5xx 4; поза outbox'а — never throws, кап
  64 KB). Worker переливает в `run_events` `channel_failure` на всех терминальных
  ветках + вторым сканом реконсайлера; идемпотентность — атомарный rename-claim;
  статус/outcome не пишутся никогда (правило 7); скраббер на error.message.
  Таймлайн: карточка «Сбой callback-канала» (kv, danger, Unplug). Тесты: юниты
  писателя/ридера + real-fetch contract case (refused connection ⇒ breadcrumb) +
  `channel-breadcrumbs.spec.ts` (exit/reconcile/гонка/ретеншн).
- **C. Channel-health**: `GET /api/channel-health` (dashboard-bearer, additive;
  `ChannelHealthResponseSchema`) — оконные счётчики failures/probe-отказов,
  `last_successful_callback_at` (тег `via:'callback'` на живых progress-событиях),
  вердикт deployment guard'а из процесса backend'а, `affected_runs` cap 20.
  degraded ⇔ probe ≥ 1 | failures ≥ 3 | guard не ok (окно 15 мин; env-тюнинг,
  ленивое чтение). UI: индикатор в сайдбаре (поллинг 5 c, `placeholderData`),
  поповер с фактами и ссылками на прогоны; маркер `callback_alert` в списке
  прогонов (EXISTS-проекция механизма 026). Живой drill: seed `channel_down` →
  индикатор красный + поповер с BRG-1 → старение события → healthy.
- **Решения**: наблюдаемость НЕ гейтит прогоны (admission — только pre-flight
  probe); общий configRoot между режимами намеренно (реконсайлер активного
  worker'а дорезолвит чужие файлы); `run_events.type` — без миграций.

**Гейты.** `pnpm typecheck && pnpm lint && pnpm test`, полный
`pnpm test:integration` — зелёные (новые сьюты: worker-lock,
channel-breadcrumbs, channel-health; веб: индикатор, маркер, presenter).
Phase-0 прогоны не затронуты; callback-эндпоинты и Jira-путь не тронуты;
схема БД без изменений.

## Iteration 42 — Третий provider-пресет: executor type `deepseek_api` (feature 028, 2026-07-22)

Точный аналог фичи 025 (kimi/Moonshot): `deepseek_api` — НЕ direct-API
исполнитель, а третий provider-пресет над общим Claude CLI harness'ом против
официального Anthropic-совместимого endpoint'а DeepSeek
(`https://api.deepseek.com/anthropic`). Спека `specs/028-deepseek-executor/`.

- **Контракты**: `DeepseekExecutorApiConfigSchema` (strict, write-only
  `api_key`, key-required-on-create) во всех трёх union'ах;
  `DeepseekExecutorConfigSchema` заменил passthrough-заглушку;
  `'deepseek_api'` в `RUN_QUEUE_EXECUTOR_TYPES` (одна строка = provisioning
  очереди `run.deepseek_api`). **FR-016-консолидация**: наборы
  `CLI_HARNESS_EXECUTOR_TYPES` / `CLI_HARNESS_API_EXECUTOR_TYPES` /
  `API_KEY_ONLY_EXECUTOR_TYPES` (+ гарды, включая object-level
  `isApiKeyOnlyExecutorRequest` — предикат по discriminant-свойству nest'овский
  webpack-TS не сужает) — четвёртый провайдер расширяет константу, а не
  параллельные if'ы в схемах/контроллере/форме/executor'е.
- **Runtime**: константа `DEEPSEEK_ANTHROPIC_BASE_URL` рядом с MOONSHOT;
  keyless-guard обобщён на api_key-only набор (пер-провайдерное сообщение,
  kimi-текст байт-в-байт прежний); `DEEPSEEK_EXECUTOR = Symbol` + useFactory
  (registry-only, без сабкласса); `DeepseekRunProcessor extends
  ClaudeCliRunProcessor` (`maxStalledCount: 0`, `autorun: false`) + регистрация
  в `WorkerLockBootstrap.workers()` — БЕЗ неё очередь провижнится, но никогда
  не потребляется (грабля feature 027, в бриф не входила).
- **UI**: тип в селекторе; key-блок безусловно (Replace без Clear); хинт модели
  с НАТИВНЫМИ id (`deepseek-v4-pro`/`deepseek-v4-flash`) + предупреждение:
  нераспознанное имя DeepSeek МОЛЧА роутит в `deepseek-v4-flash`; индикативный
  маркер стоимости распространён на deepseek-прогоны (provider-aware tooltip).
- **Live-smoke против реального API (FR-017, определение done)**: прогон
  `deepseek-v4-flash` реальным `claude` 2.1.207 через герметичный
  integration-harness — `succeeded` штатным путём; **главная гипотеза
  ПОДТВЕРЖДЕНА: client-side stdio MCP работает против DeepSeek** (report только
  через `complete_task` + 3× `report_progress` на таймлайне; «MCP unsupported»
  в доках DeepSeek — про серверный API-коннектор); tool use — SMOKE.md
  закоммичен и запушен; ключ нигде не всплыл. **Известное ограничение**:
  endpoint не возвращает usage → `cost_usd`/`usage` = NULL на deepseek-прогонах
  (зафиксировано в architecture §4 и contracts/deepseek-provider-env.md).
- **Тесты** (все зелёные): юнит-матрицы обеих схем, `applyProviderEnv` на три
  пресета, реестр/модуль, `run.deepseek_api` в наборе очередей, веб-форма и
  маркеры (+6 web); интеграция — 4 сьюта-зеркала kimi (run/gate/security/crud,
  438 total). Регрессионный пол: сьюты ≤027 без модификаций, снапшоты нетронуты,
  kimi/claude_cli env байт-в-байт. Zero DDL.

## Iteration 43 — Страница /metrics: кумулятивная статистика на таймлайн-графиках (feature 029, 2026-07-22)

Новая read-only страница дашборда `/metrics` — первый в кодовой базе набор агрегатов `date_trunc`/`generate_series`/`percentile_cont` и первая графическая библиотека во фронте. Пять вкладок (Обзор / Расходы и токены / Здоровье прогонов / Активность и триггеры / Люди в контуре) + общие фильтры сверху (период 24h/7d/30d, воркспейс, executor_type). **Без миграций** — проекция существующих `runs`/`human_tasks`/`agents`/`workspaces`.

- **Бэкенд**: `MetricsController` (`GET /api/metrics/{overview,cost,reliability,activity,human}`) за `DashboardTokenGuard`; вся арифметика бакетов в `metrics.helpers.ts`. Ключевые решения: гранулярность `24h→hour`, иначе `day` (R2); **явное UTC-усечение** `date_trunc(gran, ts, 'UTC')` — литерал гранулярности инлайнится (не bind-параметр), иначе SELECT и GROUP BY получают разные `$n` и Postgres роняет «must appear in GROUP BY» (грабля, поймана интеграционно); плотная сетка бакетов на epoch-мс в JS совпадает с SQL-ключами бит-в-бит; long→wide пивот с zero-fill (R3/R5). Деньги — строкой (`::text`). `percentile_cont` игнорирует NULL-длительности → незавершённые прогоны не искажают median/p95 (FR-012). Ряд длительности якорится на `finished_at`, остальные на `created_at` (FR-005a/M2). `executor_type` НЕ применяется к `/human` и карточке `open_human_tasks` (H1/FR-011a). Невалидный `workspace_id` → 200 с пустой сеткой (M8), не 4xx. `top_workspaces_by_cost` — LIMIT 10, только без фильтра воркспейса (M7); `ORDER BY coalesce(sum,0)` чтобы NULL-cost воркспейс не всплывал первым.
- **Фронтенд**: ECharts через tree-shaken `echarts/core` + `vue-echarts` (R1); `charts/echarts.ts` — регистрация, тема из `var(--el-color-*)` (пересобирается при смене color mode), билдеры `timeSeriesOption`/`categoryBarOption`; `ChartCard.vue` — обёртка (заголовок + `<v-chart>` + `el-empty` + `v-loading`). `MetricsPage.vue` — `el-tabs` с ленивым монтированием панелей (FR-004), состояние (таб + 3 фильтра) круглит через query-string URL двунаправленно (R11/SC-002). Executor-пикер `disabled` на вкладке «Люди в контуре» (H1). Статусы на графиках красятся из того же `--el-color-*`-мэппинга, что `RunStatusTag`.
- **DRY-рефактор (M6)**: `INDICATIVE_COST_PROVIDERS`/`costIsIndicative`/`indicativeCostTip` вынесены в `utils/executorCost.ts` из ТРЁХ inline-копий (`Runs.vue`, `RunCard.vue`, новый `MetricsCost.vue`); единый label-map `utils/metricsLabels.ts` (`__unknown__`→«не определено», типы токенов, kinds) — FR-017/M5.
- **Тесты** (все зелёные): контракт round-trip (`metrics.schema.spec.ts`, +5 describe); интеграция против реального Postgres (`test/integration/metrics.spec.ts`, 18 кейсов) — все 5 эндпоинтов, инварианты `points.length===buckets.length`, zero-fill, UTC-границы бакетов (M4), median-только-по-завершённым, **finished_at-якорь длительности (M2)**, консистентность overview↔reliability (SC-003), `__unknown__` при NULL (FR-014), executor игнорируется на `/human` (H1), 401, invalid-workspace (M8), **perf-smoke: число бакетов не зависит от числа строк (M9/FR-013)**; веб-компоненты (msw + `vue-echarts` застаблен, +6 файлов: page/overview/cost/reliability/activity/human) + пункт сайдбара. Корневые гейты `typecheck && lint && test` зелёные (326 web/unit/contracts). Zero DDL.

## Iteration 44 — Инструкции агентов из git-репозитория (feature 030, 2026-07-23)

Бригадир при сборке команды берёт per-role шаблоны инструкций (`roles/<slug>.md`, YAML-frontmatter + тело-промпт) из курируемого git-репо и **адаптирует** их под проект, вместо сочинения каждой инструкции с нуля. Разрешение источника на прогон: **workspace override ?? global setting ?? встроенные дефолты**. Реализовано тремя срезами (US1/US2/US3).

- **US1 (встроенные шаблоны, end-to-end, без сети/секретов)**: контракты `role-template.schema.ts` (RoleTemplate/-Summary/-Source, капы 50 файлов/32KB/30s, URL-allowlist https/ssh, `file://` запрещён) + `default-role-templates.ts` (developer/qa/reviewer/planner, зеркалят `siberiadev/agents`); две callback-тулзы `list_role_templates`/`get_role_template`; новая либа `libs/agent-templates` (resolver + `TemplateRepoService`); `TemplateReadService` + `GET /callbacks/runs/:id/templates(/:slug)` за RunTokenGuard; MCP-прокси; bounded-каталог в setup-handoff + две секции в `DEFAULT_WORKSPACE_SETUP_INSTRUCTION` (использование шаблонов + выбор executor'а по `model_hint`). Шаблоны влияют ТОЛЬКО на создание команды; `agents.instruction` в рантайме не трогается.
- **US2 (git-источник + секреты)**: `clone-cache.ts` (execFile git, self-healing клон/checkout по ref — worktree.ts, incident-hardened, НЕ трогали), `frontmatter.ts`, `git-auth.ts` (токен приватного репо → git-ребёнок через ephemeral `GIT_CONFIG_*` env; НЕ argv, НЕ окружение агента). Миграция **0009** — `workspaces.agent_instructions_token bytea` (sealed, тот же AES-256-GCM/ключ, что `jira_credentials`) + REVIEW-0009 + architecture §3. DB-хелперы workspace/global источника; `database` без crypto-слоя (seal/open на краях). Резолвер: precedence + fallback-on-failure + диагностика + правило token↔URL pairing. Битый/недоступный источник НИКОГДА не блокирует setup — откат на дефолты с пометкой.
- **US3 (управление из UI и admin-MCP)**: `WorkspaceCreate/SettingsRequest`/`WorkspaceResponse` += `agent_instructions` (+ tri-state токен, `has_agent_instructions_token`, `effective_instructions_level`); новый `GET/PUT /api/agent-instructions-settings` (глобальный источник, tri-state токен, `has_token`); web — карточка «Agent instruction templates» в General + блок «Agent instructions source» в настройках workspace (write-only токен, индикатор эффективного источника); admin-MCP — passthrough `agent_instructions` в `create_workspace` + новая тулза `set_agent_instructions_source` (токен — только из env `BRIGADIR_AGENT_INSTRUCTIONS_TOKEN`, не из аргументов).
- **Безопасность**: токен sealed at rest, write-only по API (в ответах только `has_*`), в git — только через child-env (не argv/не окружение агента), нигде в логах/событиях/ответах. Принцип V.
- **Тесты** (все 030-зелёные): contracts 226; unit-проект 524 (resolver/service/frontmatter/git-auth/clone-cache на реальном локальном git/handoff/template-read); mcp-server 40; admin-mcp 19; web (+3 компонентных); интеграция — 11 (US1 каталог+эндпоинты, US2 DB-driven precedence/fallback/не-утечка токена, US3 settings API global+workspace). Корневые `typecheck && lint` зелёные. Успешный live-fetch (allowlist блокирует локальный fixture) — на реальном `git@github.com:siberiadev/agents.git`. Известное: 2 пред-существующих web-падения по indicative-cost deepseek_api (feature 028) — вне скоупа 030.

## Iteration 45 — Env-переменные для прогонов агентов (feature 031, 2026-07-24)

Оператор задаёт env-переменные, которые инжектятся в спаун агента, чтобы он поднимал сервисы, коннектил их к бэкенд-зависимостям и тестировал. Слоёная модель: **workspace-дефолты ⊕ per-repository (главный дом) ⊕ per-agent override**, слияние по precedence на старте прогона; platform-ключи (auth/provider/bootstrap) применяются ПОСЛЕ операторского env и неперебиваемы. Гибрид хранения: несекретное — открыто в jsonb, секретное — один запечатанный `env_secrets bytea` на workspace (тот же AES-256-GCM конверт/ключ, что `jira_credentials`), write-only. Единственная DDL — миграция **0010** (nullable `workspaces.env_secrets`).

- **Foundational**: `env.constants.ts` (dep-free — регэксп имени, `RESERVED_ENV_KEYS`/prefixes, капы 8KB/64KB, `isReservedEnvKey`; web-алиас `@brigadir/contracts/env`) + `env.schema.ts` (zod `EnvMapSchema` с per-key/per-value/total-cap рефайнментами, именующими ключ). `libs/executors/env-secrets.ts` (seal/open + `envSecretKeys` names-only, зеркало `executor-secrets.ts`), `user-env.ts` (`composeUserEnv` precedence + `assembleRunUserEnv` слияние plaintext+секретов по скоупам, возвращает secret-values для скраббера + `applyUserEnv` мутирует child-env, дропает reserved). `makeScrub(extraLiterals)` — пер-run обёртка над глобальным `scrub` (редактит точные литералы секретных значений — короткий/словарный пароль энтропийная эвристика не ловит). Репо получают стабильный `id` (uuid, ленивый backfill в `workspace-settings.ts`) — секреты ключуются по id (rename-safe).
- **US1 (env доезжает до прогона)**: компоновка в `ClaudeCliExecutor.loadRunConfig` (единственное место, где известен набор смонтированных репо), инъекция в `runProcess` строго МЕЖДУ `buildChildEnv` (allowlist-floor) и `applyAuthEnv`/`applyProviderEnv` — `ALLOWLIST_KEYS` НЕ расширяется. Только repo-mounted прогоны (triage/no-repo — пустой env). Фиксируется на спауне (как argv прав). Дропнутые reserved-ключи → warn-диагностика.
- **US2 (секреты write-only + скраб)**: `PUT /api/workspaces/:id/env-secrets` (RMW запечатанного блоба, скоуп workspace|{repository_id}|{agent_id}, значения не эхаются), `env_secret_keys` (names-only) в `WorkspaceResponse`. Fail-fast перед спауном, если блоб не открывается (SecretBoxError). Пер-run скраббер строится из расшифрованных секретных значений и применяется в стрим-парсере + stderr-tail/diagnostics. Прун секретов при удалении репо (settings PUT) и агента. Гард «один дом на ключ» в обе стороны (plaintext↔secret, 409).
- **US3/US4 (UI)**: переиспользуемый `EnvVarsTable.vue` (несекретные строки редактируются inline, секретные — маскированы, без reveal; inline-валидация тем же dep-free правилом, что сервер; бейдж «overrides»). Интегрирован в `ConfigForm` (workspace-дефолты + per-repo env, секреты — немедленно через env-secrets endpoint) и в свёрнутую advanced-секцию `AgentForm` (per-agent override). Хинт «Applies to new runs».
- **US5 (admin-MCP)**: `create_workspace.repositories[].env` + новая тулза `set_env` (скоуп workspace/repository/agent). Секреты передаются как `{key, secret_from_env}` — имя переменной в окружении САМОГО admin-сервера, значение резолвится сервером и через модель не проходит (дисциплина feature 030). `create_workspace` бэкфиллит repo-id при создании, чтобы секреты сразу привязались.
- **Конституция §V — сужение** (записано в constitution.md): правило «секреты не в env агента» касается ПЛАТФОРМЕННЫХ секретов; операторский сервисный env предназначен агенту по определению, ограничен переданным, запечатан, инжектится после floor и до auth, и регистрируется в скраббере. Аналог сужения feature 015.
- **Тесты** (все зелёные по feature 031): contracts (env.schema + dashboard), executors unit (user-env precedence/reserved/caps, env-secrets codec, executor spawn-env: injection/allowlist-floor-with-user-env/zero-config-byte-identical), scrubber (makeScrub литералы), admin-mcp (create_workspace env-map + set_env, секрет-литерал не в результате), web (EnvVarsTable + AgentForm override/collapsed). Интеграция против реального Postgres+spawn: `env-variables.spec.ts` (precedence, allowlist-floor, secret leak-sweep run_events/report/error), `env-secrets-api.spec.ts` (names-only, per-scope set/delete, reserved 422, both-direction 409, 404). Предсуществующие падения вне скоупа: web metrics-* (echarts не установлен в этом воркетри) и 2 deepseek indicative-cost (feature 028).

## Iteration 46 — Наследование веток по связанным тикетам + настраиваемый порог релиза (feature 032, 2026-07-26)

Цепочки тикетов («B is blocked by A») стали пригодны к использованию: оператор выбирает статус блокера, на котором зависимые могут стартовать, и каждый зависимый прогон стартует **от кода своего блокера**, а не от дефолтной ветки. **Без миграций** — новое поле в `workspaces.settings` (jsonb), изменённая семантика записи существующей колонки и новые payload'ы в существующих таблицах.

- **US1 (ранний релиз)**: `workspaces.settings.dependency_release_status` (имя Jira-статуса; `z.string().trim().min(1).optional()`) + аксессор `getDependencyReleaseStatus`. Гейт `evaluateDependencyGate/blockingKeys` принимает `opts.releaseStatus`; связь удовлетворена, если имя статуса блокера совпало (trim + case-insensitive) **ИЛИ** категория `done` — ветка «ИЛИ done» безусловна, чтобы блокер, перепрыгнувший настроенный статус, всё равно отпускал зависимых. Настройка читается ОДИН раз на проход/событие и threaded в ОБА места вызова (`DependencyReleaseService.process`, `PipelineService.onStatusChanged`) — FR-003. Неизвестное имя статуса не отвергается: гейт деградирует к правилу done-категории, дашборд показывает предупреждение (сверка с существующим `GET /workspaces/:id/statuses`, `el-select` с `allow-create` — блокер может жить в другом проекте; сам селект живёт в модалке Edit блока General, в описаниях значение только читается — конвенция Settings-таба, реш. 2026-07-13), релиз-пасс пишет ОДИН `logger.warn` за проход. Прогон, отпущенный только по совпадению имени, помечается событием `dependency-release, early: true`.
- **US2 (наследование ветки блокера)**: `tickets.blocked_by` из «открытые блокеры, пока ждём» превратился в **наблюдение** — поллер пишет его на каждом проходе (`[]`, если связей нет), релиз больше НЕ обнуляет колонку; `blocked_state` остаётся единственным признаком ожидания (все читатели «кто ждёт?» фильтруют по нему; containment-запрос fast-path'а корректен благодаря NOT-EXISTS-клаузе). Резолв старта в `prior-work.ts` получил третий уровень: `getBlockerWork` (окно 5, те же правила `matchReportedBranches`) + `buildStartPlan` — precedence **по репозиторию**, слияний между уровнями нет. Порядок prepare: `ensureCaches` (его `fetch --prune` делает пробы правдивыми) → резолв блокеров → `prepareAll`.
- **Асимметрия пропавшей ветки (FR-008)**: ветка, названная СВОЕЙ прошлой работой и отсутствующая на origin, по-прежнему роняет прогон громко (feature 023). Ветка блокера, которой нет: блокер `done` ⇒ тихий старт с дефолтной + событие `blocker_branch_merged`; блокер открыт ⇒ старт с дефолтной + `blocker_no_artifact` + задача `[blocker_branch_lost]`. Категорию берём ОДНИМ батч-запросом `key in (…)` к живой Jira на prepare (кэш тикетов категорию не хранит; Принцип I); сбой запроса роняет прогон с диагностикой — молчаливого фолбэка нет. Тикет без наблюдённых блокеров не делает ни одного лишнего запроса.
- **US3 (diamond'ы)**: два блокера с работой в одном репо ⇒ система сама сливает их последовательно `--no-ff` в detached-воркти (`git -c user.name=brigadir -c user.email=brigadir@local` — глобальный git-config не пишем). `startSha` резолвится ПОСЛЕ последнего слияния, поэтому база completion-gate (feature 024) включает слитую работу по построению и правило 024 не меняется. Конфликт ⇒ `merge --abort`, `BlockerMergeConflictError`, существующий all-or-nothing unwind, задача `[blocker_merge_conflict]`; автоматически конфликт не разрешается.
- **US4 (кросс-сервис)**: монтирование по-прежнему = база агента, суженная Components тикета, и наследование его НИКОГДА не расширяет (FR-010). Работа блокера в несмонтированном репо ⇒ событие `blocker_artifacts_unmounted` + задача `[blocker_repo_unmounted]`, называющая обе починки.
- **US5 (диагностируемость)**: пять новых `decision` в `start-ref` (`inherited_from_blocker`, `merged_blockers`, `blocker_branch_merged`, `blocker_no_artifact`, `blocker_artifacts_unmounted`) + поля `blockers`/`mergedBranches`; презентер рисует их kv-списком с чипом решения (правила feature 026 — никаких JSON-дампов; `TimelineEvent.vue` теперь умеет показывать текст И kv одновременно). Обёртка: строки провенанса на репо (DEPENDENCY / merged) — ФАКТЫ, не инструкции (D7), плюс блок `## Linked tickets` (прямые блокеры, порядок по ключу, кап 10, кап строки 200) на обоих каналах.
- **Две осознанные девиации (plan.md Complexity Tracking)**: (1) три «вида» задач реализованы детерминированным машинным префиксом заголовка + дедупом по точному заголовку (`createKeyedTicketTask` в `libs/database`, чтобы сервис и executor делили ОДИН гард), а `human_tasks.kind` остаётся `blocker` — `HumanTaskKind` версионируемый контракт агента, расширять его ради внутренней диагностики нельзя; (2) статус блокера на prepare берётся живым батч-запросом, а не новой колонкой кэша — нужна КАТЕГОРИЯ, которой в кэше нет, и свежесть именно в этой точке решения.
- **Тесты** (все зелёные): unit — `dependency-gate.spec` (полная таблица решений + `allBlockedByKeys`/`earlyReleaseBlockers`), `workspace-settings.spec`, `dependency-release.spec` и `pipeline.service.spec` (проводка настройки, early-событие), `prior-work.spec` (`buildStartPlan`: precedence по репо, порядок merge, unmounted), `worktree.spec` (**реальный git**: чистое слияние, `--no-ff`, `startSha` после merge, конфликт + unwind, отсутствующая/битая merge-ветка, `branchExistsOnOrigin`), `wrapper.spec` (4 варианта строк + Linked tickets + байт-идентичность), human-task дедуп по заголовку, web-презентер. Интеграция (Docker) — `dependency-gate.spec` (+5 кейсов настроенного порога), новый `blocker-inheritance.spec` (12 кейсов: наследование, своя работа выигрывает, обе ветки матрицы + дедуп задачи, diamond чистый и конфликтный, completion-gate на merge-коммите, кросс-сервис, unmounted + дедуп, полнота событий, FR-016), `sprint-sequencing.spec` (+4 кейса матрицы записи `blocked_by`). Предсуществующие падения вне скоупа: 2 web-кейса indicative-cost `deepseek_api` (feature 028) — падают и на чистом дереве.

## Iteration 47 — Запрет in-session sleep-ожидания (token-spend problem 1, 2026-07-28)

Анализ 176 прод-прогонов (`docs/token-spend-analysis-2026-07-28.md` §1): 621 Bash-тёрн `sleep`-поллинга (худший случай — 101 × `sleep 600` в одном Reviewer-прогоне); каждый поллинг-тёрн перечитывает весь кэш-контекст. Ожидание должно ЗАВЕРШАТЬ сессию (платформа перезапустит прогон), а не крутиться в ней; wakeup-поллинг не дешевле sleep-поллинга — тёрн есть тёрн.

- **PreToolUse bash-guard** (`packages/mcp-server/src/bash-guard{,-logic}.ts`): deny sleep-доминантных Bash-команд на границе harness'а — sleep в цикле (`while|until|for` + `done`), непарсимая длительность (`sleep $DELAY`), кумулятивно >15 c; короткие sleep проходят. Reason начинается со стабильного префикса `[brigadir-bash-guard]` (контракт для stream-parser, литерал пинится обоими spec'ами) и направляет в `request_human(blocking=true)` / `complete_task(outcome="failure"|"needs_human")` — НЕ в ScheduleWakeup. Fail-open (exit 0 на любом пути); регистрация — `hooks.PreToolUse` в `--settings` блобе рядом со Stop-hook (`mcp-config.ts`). Принятый v1-ложняк: space-preceded `sleep <n>` в кавычках прозы.
- **`--disallowed-tools ScheduleWakeup`** (только callback-ветка `buildArgs`; Phase-0 argv байт-идентичен): CLI автопредлагает тулзу даже вне `--allowed-tools` (проверено live), а wakeup-поллинг стоит как sleep-поллинг.
- **Wrapper-обобщение**: запрет ждать in-session ЛЮБОЕ предусловие (CI, деплой, другой тикет, ответ человека, инфраструктура) + обе тулзы выхода; инфраструктурный буллет сохранил «3 ретрая → request_human».
- **Наблюдаемость**: deny всплывает в `user`/`tool_result` → stream-parser (bounded pending-map 50, санитайзер 026) эмитит `run_events` `tool_denied` {name, command?, reason, truncated}; словарь run-events дополнен; web-таймлайн — иконка Ban + тег denied (`presenter.ts`/`TimelineEvent.vue`). SQL deny-статистики решит судьбу отложенного слоя `awaiting_dependency`-парковки.
- **Верификация**: unit (mcp-server 70, executors claude-cli 72, web timeline 51) + интеграция `claude-cli-lifecycle` (tool_denied персистится) + smoke бинаря + **live-verify на CLI 2.1.218** (`sleep 600` реально denied, modern `hookSpecificOutput`-форма работает; ScheduleWakeup исчезает из init tools с флагом). Контракты: `stop-hook-settings.md` (секция bash-guard), `cli-io.md` (argv + tool_denied). Предсуществующие падения вне скоупа: 2 web-кейса indicative-cost `deepseek_api`.

## Iteration 48 — Квитанции верификации на уровне тикета (feature 033, token-spend problem 2, 2026-07-29)

Каждая роль (Developer → QA → Reviewer) перегоняла те же гейты на ТОМ ЖЕ коммите (26 lint-вызовов на 10 тикетах тремя ролями; Reviewer с 24 × `tsc --noEmit`), потому что handoff не нёс записи «что уже проверено». Теперь платформа записывает sha-якорную квитанцию в тикет и подливает её следующему прогону.

- **Контракт** (`packages/contracts/src/verification-receipt.schema.ts`): `VerificationReceiptSchema` {version, runId, agentRole, agentName, outcome, recordedAt, gates[≤10], repos{name→40-hex sha}} + чистые `buildVerificationReceipt` (pass-чеки, дедуп, кап 120 симв., undefined без evidence) и `matchVerificationReceipt` (safeParse + строгий whole-workspace матч: набор репо квитанции РАВЕН смонтированному и каждый sha совпал; мусор/legacy → undefined).
- **Запись** (`CallbackService.complete`, после успешного finalize): evidence-gated — измеренный `x-brigadir-observed-heads` (MCP-сервер, `rev-parse HEAD` всех смонтированных репо) + ticketId + ≥1 pass-чек; для ВСЕХ исходов отчёта (упавший QA с честными lint/tsc pass экономит rework-прогону гейты); whole-replace `tickets.verification`; fail-open (сбой квитанции никогда не ломает completion); событие `verification-receipt`. Exit-time/outbox-пути evidence не имеют → не пишут.
- **Чтение** (executor prepare, после `prepareAll`/start-ref, только callback-канал): сравнение квитанции со `startSha` каждого репо; полный матч → секция `## Already verified at this exact state` в обёртке (гейты + короткие sha, правило «не перегонять на неизменном коде, гонять только своё; любой новый коммит обнуляет всё», advisory с эскейп-хатчем) + событие `receipt-injected`; валидная, но несовпавшая → `receipt-stale` (наблюдаемая инвалидация), мусор — молча. Телеметрия injected/stale — мера эффекта.
- **DDL**: миграция **0012** — nullable `tickets.verification` jsonb (+snapshot/journal, REVIEW-0012, architecture §3); очистки нет — протухание самоизлечивается sha-mismatch'ем. `lockfile_hash` не нужен: локфайл закоммичен, тот же sha ⇒ тот же локфайл.
- **Тесты** (все зелёные): contracts 257 (builder/matcher, все ветки отказа), callback unit 29 (запись/скипы/fail-open/failure-outcome), executors unit 75 (wiring инжекции + stale, wrapper-секция + equality-тесты байт-идентичности обоих каналов), интеграция `verification-receipt.spec.ts` (полная цепочка run1→run2 с реальным push, whole-replace на run2, out-of-band инвалидация, fail-closed без квитанции; fake-CLI commit-шаг получил опциональный `push`). Контракты: `callback-http-api.md` (сайд-эффект complete), architecture §7 (секция обёртки).

## Iteration 49 — Аудит энфорсмента таймаутов / watchdog (feature 034, 2026-07-29)

Прод-инцидент из token-spend-анализа: Reviewer-прогон прожил ~17 часов в `running` при таймауте 45 мин — «watchdog обязан был убить прогон раньше, проверяется отдельно». Аудит нашёл цепочку из двух несущих дыр и россыпи мелких; закрыто всё.

- **Watchdog независим от Jira** (`libs/ingest`): `WatchdogService.sweepAll()` — первый шаг reconcile-пасса, ДО резолва Jira-клиентов и цикла по воркспейсам (раньше протухший токен/упавшая интроспекция борды молча выключали жатву воркспейса — `continue` мимо чисто-DB шага). Свипятся все воркспейсы, включая disabled (зомби-`running` держал `runs_one_active` вечно); для disabled — DB-флип без Jira (FR-028), доносит drift repair. `resolveMinutesSetting`: битое/пустое `WATCHDOG_GRACE_MINUTES` → warn + дефолт 5 (NaN в SQL-интервале молча отключал sweep). Каждая жатва — run_events `log`/`source:'watchdog'` (прецедент start-ref, web не менялся).
- **Sweep застрявших `queued`** (обещан spec.md:84/:308, не существовал): `queued` дольше `WATCHDOG_QUEUED_SWEEP_MINUTES` (дефолт 720 — заведомо больше rate-limit-репарковок 5h-окна) при `started_at IS NULL` → `failed` («ничего не стартовало», не `timed_out`), освобождает active-слот тикета.
- **Settlement-fallback исполнителя**: промис резолвился ТОЛЬКО по `close` — сбежавший потомок с унаследованным stdio вешал `await executor.run()` навсегда (одноразовый AbortSignal потрачен, `finally` процессора не выполнялся, слот сгорал). Теперь оба kill-пути (abort И rate-limit — инцидент Captain Nemo) после `terminate()` вооружают таймер `settleGraceMs` (конфиг, кламп [100, 60000], дефолт 5 с): нет `close` → принудительный settle через существующий `handleClose(null)` (прецедентность cancelled > rate_limited > timeout сохранена) + событие `source:'settlement-timeout'`.
- **Абортируемый prepare + git-таймауты**: `signal` теперь проверяется на границах фаз (`loadRunConfig` → `ensureCaches` → `prepareAll` → spawn) и прокинут в сетевые git-операции; каждый git-вызов worktree-слоя несёт hang-breaker `WORKTREE_GIT_TIMEOUT_MS` (10 мин, локальная константа — 30-секундный `GIT_OP_TIMEOUT_MS` contracts бюджетирует мелкие template-репо). Abort в prepare → исход `cancelled`/`timeout` (раньше — `crashed`: сжигал attempt на отмене и врал про таймаут); проверка aborted — ДО ветки `BlockerMergeConflictError`.
- **Кламп `timeout_ms_override`**: `sanitizeTimeoutMs` (кап 24 ч, garbage → fallback, малые значения прозрачно — sub-second фикстуры limits-тестов) по образцу `sanitizeRateLimitTtl`; фолбэк из `timeout_minutes` клампится тоже.
- **Отложено осознанно**: таймер mock-пути (mock игнорирует signal; страхует Jira-независимый watchdog), UI `:max`/zod-кап `timeout_minutes` (косметика после клампа в воркере), таймаут `awaiting_human` (осознанное исключение spec.md:308).
- **Тесты** (все зелёные): unit — `resolveMinutesSetting` (таблица, включая `Number('')===0`-ловушку), `sanitizeTimeoutMs`, `normalizeSettleGraceMs`, executor (7 новых: fallback timeout/cancelled/rate-limited-без-abort, поздний close = no-op, close в окне без события, pre-aborted prepare, hung ensureCaches → timeout), worktree (3 новых abort-кейса на реальном git); интеграция — новый `watchdog-jira-independence.spec.ts` (битые креды → `ReconcileService.run()` всё равно жнёт; disabled → флип без Jira; queued 13h → failed / 1h → нетронут), `reconcile-catchup` обновлён на `sweepAll`. Доки: architecture (§backpressure + §результат процесса), `executor-config.md` (`settleGraceMs`), `.env.example` (обе ручки watchdog).

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

---
description: "Task list for Workspace & Agents UI — the first web dashboard + the DB-authoritative config flip"
---

# Tasks: Workspace & Agents UI

**Input**: Design documents from `/specs/005-workspace-agents-ui/`
**Prerequisites**: plan.md, spec.md, research.md (R1–R6), data-model.md, contracts/ (dashboard-api, credentials-codec), quickstart.md

**Organization**: Phases follow plan.md's Phase-2 implementation outline — **backend before frontend**, each backend layer landing with its integration tests in the same phase. Story labels map to spec.md: **US1** workspace wizard + verified create (P1, MVP), **US2** agent CRUD + mini-linter (P2), **US3** DB-authoritative config flip (P2), **US4** settings + token rotation (P3), **US5** credentials encrypted at rest (P2, cross-cutting). US5 is sequenced first because the wizard (US1) stores real tokens the instant it ships — encryption must be in place before any UI persists a credential.

**Task IDs continue from T119** (iteration 4 ended at T116; T117 live-smoke and T118 DoD journal remain pending and are unrelated to this iteration). This iteration is **T119–T159**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task in the same/earlier phase
- **[Story]**: US1–US5 where the task serves a specific user story; setup/foundational/DoD tasks carry no story label
- Every task names its **Verify:** step (command or concrete check)

## Path Conventions

Monorepo root = repository root. New/changed code this iteration:
`packages/contracts/src/{dashboard.schema.ts,agent-linter.ts,jira.types.ts}`;
`libs/jira/src/{credentials.codec.ts,credentials-key.provider.ts,jira-client-factory.ts,statuses.service.ts,lazy-jira.client.ts,jira.module.ts,jira-client.interface.ts,basic-auth-jira.client.ts}`;
`libs/app-config/src/{config-seeder.ts,agents-config.provider.ts}`;
`libs/queues/src/queues.module.ts`;
`apps/backend/src/{dashboard/*,main.api.ts,app.module.ts}`;
`apps/web/` (**new non-Nest Vite package** — kept out of `nest-cli.json`);
`test/integration/*`. **No DB migration** — every column already exists in architecture §3 (data-model.md verdict).

**Threaded through every phase (non-negotiable):**
- **No `${VAR}` secret interpolation anywhere** (Constitution V) — `BRIGADIR_CREDENTIALS_KEY` and `BRIGADIR_DASHBOARD_TOKEN` are read from `process.env` inside DI factories, never templated into a child process or a config file.
- **`BRIGADIR_CREDENTIALS_KEY` is a hard boot requirement for BOTH backend and worker** — same posture as `BRIGADIR_JWT_SECRET`: a DI-factory provider with **no silent default**; a missing/mis-sized key is a boot error. This collapses the legacy-plaintext read-tolerance window (research R2) to the boot-migration pass itself — there is never a running key-less plaintext regime.
- **Serve-static SPA fallback must not shadow `/api/*` or `/health`** — route precedence is asserted by test.
- **Feature 001–004 suites stay green** — the seeder flip must not break fixtures that rely on `AGENTS_CONFIG_PATH` (`run.mock` stays provisioned via the registry).

---

## Phase 1: Setup — Shared contracts (linter, dashboard DTOs, repositories typing)

**Goal**: the typed surface both the backend authority and the `apps/web` client will import — the pure mini-linter, the dashboard request/response schemas, and the `repositories[]` settings shape — exists and unit-passes standalone. **⚠️ Blocks the dashboard API (Phase 4) and the frontend (Phases 5–8).**

- [X] T119 [P] Add dashboard request/response schemas to `packages/contracts/src/dashboard.schema.ts` (zod, single typed source) per `contracts/dashboard-api.md`: workspace verify/create/rotate/settings request bodies, the `Workspace` response (credentials **never** included; derived `credential_status: "ok"|"warn_30"|"warn_7"|"expired"`), agent create/update body (full field set incl. `status_ids` + `behavior.use_callback_channel`), and the **path-qualified error shape** (`{ error:{ code, message, issues:[{path,code,message,value?,level}], warnings:[…] } }`). Export from `packages/contracts/src/index.ts`. **Verify**: `pnpm --filter @brigadir/contracts build` exits 0; a unit test round-trips one valid create body and rejects a malformed one with a path-qualified issue; grep confirms no schema serializes `jira_credentials`/`api_token` in a response type.
- [X] T120 [P] [US2] **[Mandatory — linter matrix, task (d)]** Implement the pure mini-linter in `packages/contracts/src/agent-linter.ts`: `lintAgent(candidate, agentsInWorkspace, boardStatuses) → { errors:[…], warnings:[…] }` with rules & codes from `contracts/dashboard-api.md` — `status_absent` (any of trigger/running/success/failure name ∉ board flat list), `duplicate_trigger` (equals another **enabled** agent's `trigger_status` with equal/absent `trigger_jql`), `status_cycle` (A.success→B.trigger and B.success→A.trigger; **warning, non-blocking**). Pure, no I/O; exported for both backend (authority) and web (mirror). **Verify**: unit test `agent-linter.spec.ts` the full matrix — missing status → error pinned to the offending field path; duplicate trigger among **enabled** agents → error, and the **same collision with a distinct `trigger_jql` → no error**; a **disabled** agent sharing a trigger_status → **no** `duplicate_trigger` (edge case); a two-agent cycle → one `status_cycle` **warning** and zero errors.
- [X] T121 [P] [US1] Extend `WorkspaceSettingsSchema` in `packages/contracts/src/jira.types.ts` with `repositories: { name, git_url, default_branch }[]` (ordered, first = default), preserving the existing `scope_jql`/`branch_prefix`/`reconcile` fields and `.passthrough()`; add a `getRepositories(db, workspaceId)` accessor in `libs/database/src/workspace-settings.ts`. **Verify**: unit test — a settings blob with `repositories` parses; an empty blob yields `[]`; the accessor returns the ordered list; existing `workspace-settings.spec` / iteration-1 seed leftovers (`repo`/`default_branch`) still parse (forward-compat).

**Checkpoint P1**: `pnpm --filter @brigadir/contracts test` green (dashboard DTOs + linter matrix + repositories typing) with **zero** backend/DB involvement. **STOP** — do not start Phase 2 until these pass.

---

## Phase 2: Credentials at rest (US5) — AES-256-GCM codec, boot-required key, legacy migration

**Goal**: Jira credentials are AES-256-GCM-encrypted at rest, the key is a hard boot requirement for both apps, and a pre-existing plaintext blob is migrated to ciphertext on boot without losing the ability to authenticate. **⚠️ Blocks US1 (the wizard persists a real token).**

- [X] T122 [US5] Add `credentials-key.provider.ts` in `libs/jira/src/` (mirrors `libs/app-config/src/jwt-secret.provider.ts`): `BRIGADIR_CREDENTIALS_KEY` symbol + `resolveCredentialsKey()` reading `process.env`, accepting base64 **or** hex, validating decoded length === 32, throwing `CredentialsKeyMissingError` on absent/malformed — **no default**. Provide it (via `useFactory`, never `@Module()` args) in `JiraModule` so both `BackendAppModule` and `WorkerAppModule` resolve it at boot. Supply a fixed test key in **one place** — `test/integration/harness.ts` (`ensureTestCredentialsKey()` alongside `ensureTestJwtSecret()`), and in `apps/**/*` unit test setup as needed. **Verify**: unit test — a valid 32-byte base64/hex resolves to a 32-byte Buffer; a 16-byte value throws; an absent value throws `CredentialsKeyMissingError`. `harness.ts` sets the key once; grep shows no `${` templating of the key anywhere.
- [X] T123 [US5] Rewrite `libs/jira/src/credentials.codec.ts` to AES-256-GCM per `contracts/credentials-codec.md`, keeping the `encodeJiraCredentials`/`decodeJiraCredentials` signatures so no caller changes: `encode` → `0x01 || iv(12) || authTag(16) || aes-256-gcm(ciphertext)` (fresh random IV; requires key → fail-fast); `decode` **format-sniffs** `blob[0]` — `0x01` → GCM decrypt (requires key), `0x7b` (`{`) → legacy plaintext JSON (key **not** required), anything else (e.g. iteration-1 placeholder bytes) → `JiraAuthError`. Key injected via T122's provider (the codec takes the key as an arg or reads the resolved provider value; **not** `process.env` at composition). **Verify**: `pnpm --filter … build`/typecheck green; the JiraModule resolver and seeder still compile unchanged. (Behavioral coverage in T124.)
- [X] T124 [P] [US5] **[Mandatory — codec unit tests, task (a)]** `libs/jira/src/credentials.codec.spec.ts`: **round-trip** `decode(encode(c)) === c`; **envelope** — encoded blob starts `0x01`, length ≥ 29, and the raw bytes contain no `email`/token substring (not human-readable); **tamper** — flip one ciphertext byte → decrypt throws (GCM auth-tag failure); **wrong key** — decrypt with a different 32-byte key throws; **format-sniff** — a legacy `{"email":…,"api_token":…}` blob decodes correctly **without** a key, and re-encoding it yields a `0x01` envelope; **missing-key fail-fast** — `encode` and encrypted-`decode` with the key unset throw `CredentialsKeyMissingError`; **placeholder** — the `placeholder-jira-credentials` bytes still throw `JiraAuthError`. **Verify**: `pnpm test` includes these and they pass.
- [X] T125 [US5] Add the legacy-credentials boot migration in `apps/backend/src/main.api.ts` (after `runMigrations` + `ConfigSeeder.seed`): scan `workspaces`, and for every row whose `jira_credentials[0]` is the legacy `{` byte, `encodeJiraCredentials(decodeJiraCredentials(blob))` and rewrite (bumps `updated_at`). Idempotent — `0x01` rows are skipped by the sniff. Because the key is now boot-required (T122), this always runs; log a count. **Verify**: `pnpm nest build backend` exits 0; a focused unit/integration around the migration function flips a seeded plaintext row to `0x01` and leaves an already-encrypted row byte-identical.
- [X] T126 [US5] **[Mandatory — legacy migration E2E, task (b)]** Integration test `test/integration/credentials-migration.spec.ts` (testcontainers + mock Jira): seed a workspace with a **plaintext** `{email,api_token}` blob → boot the backend → assert the stored bytes are now `0x01`-enveloped (not plaintext) **and** the system still authenticates to mock Jira by decrypting them (a poller/verify path succeeds). Also assert that with `BRIGADIR_CREDENTIALS_KEY` unset the backend **fails to boot** (fail-fast, FR-023) rather than running a plaintext regime. **Verify**: `pnpm test:integration test/integration/credentials-migration.spec.ts` green.

**Checkpoint P2**: `pnpm typecheck && pnpm lint && pnpm test` green; credentials round-trip + tamper/wrong-key/missing-key covered; a plaintext row migrates on boot and still authenticates; both apps refuse to boot without the key. **STOP** — do not start Phase 3 until green.

---

## Phase 3: Source-of-truth flip (US3) — insert-if-absent seeder, registry queues, yaml-optional boot

**Goal**: the database is authoritative for workspace/executor/agent config; the yaml is an optional one-time import that never overwrites an existing row; run queues come from the fixed executor-type registry, not the yaml; boot succeeds with no yaml at all. **⚠️ Must not regress a live operator (US3 is P2 but invisible-to-fresh-install critical).**

- [X] T127 [US3] Convert `ConfigSeeder` (`libs/app-config/src/config-seeder.ts`) from `onConflictDoUpdate` to **insert-if-absent** (spec Assumption): workspace matched on `name`, executors/agents on `UNIQUE(workspace_id, name)` — if a row exists, **do nothing** (DB wins, FR-017); only insert missing rows. Keep the placeholder-credentials insert path for a brand-new yaml-seeded workspace (it will be migrated/rotated later). **Verify**: unit test — seeding twice inserts exactly one row set; pre-seeding a workspace/agent with values **differing** from the yaml leaves those values **unchanged** after `seed()` runs.
- [X] T128 [US3] Make the yaml optional at boot: `agents-config.provider.ts` `loadAgentsConfig()` returns `null` when the file is **absent** (a present-but-invalid file still fails fast); `apps/backend/src/main.api.ts` calls `ConfigSeeder.seed()` only when a config loaded, and boots cleanly on DB-only config (FR-019). Update `agentsConfigProvider` / any injector to tolerate `null`. **Verify**: unit test — absent path → `null` (no throw); invalid YAML → still throws `AgentsConfigError`. Backend boots with `AGENTS_CONFIG_PATH` pointing at a non-existent file (integration coverage in T130 case c).
- [X] T129 [US3] Flip `QueuesModule.register()` (`libs/queues/src/queues.module.ts`) to provision `run.<type>` from the fixed **`EXECUTOR_TYPES` registry** (`@brigadir/contracts`: `mock`, `claude_cli`) + `reconcile`, **removing the `loadAgentsConfig()` composition-time read** (the worker's last yaml dependency). Update the documented composition-time-read comment to cite the registry as the static-structure source (Constitution lazy-resolution carve-out). **Verify**: unit test — the provisioned queue-name set equals `['run.mock','run.claude_cli','reconcile']` regardless of any yaml/agent contents; grep shows no `loadAgentsConfig` import remaining in `libs/queues`.
- [X] T130 [US3] **[Mandatory — DB-vs-yaml boot matrix, task (c)]** Integration test `test/integration/config-source-flip.spec.ts` (SC-005/007): **(a)** empty DB + yaml present → rows imported once; **(b)** DB rows present and **differing** from yaml → DB values **survive** the boot unchanged (DB wins); **(c)** yaml **absent** → boot succeeds on DB config; **(d)** the run-queue set equals the `EXECUTOR_TYPES` registry (`run.mock`, `run.claude_cli`) independent of what the yaml or any DB agent references. **Verify**: `pnpm test:integration test/integration/config-source-flip.spec.ts` green.
- [X] T131 [US3] Regression guard: run the full feature 001–004 integration suites against the flipped seeder/queues and fix any fixture that relied on `onConflictDoUpdate` re-seeding or on yaml-derived queue names (the intent: `run.mock` still exists via the registry, so mock-driven fixtures are unaffected; a fixture that mutated a row then expected the yaml to reset it must be updated to the DB-wins semantics). **Verify**: `pnpm test:integration` green across the pre-existing suites (no new failures attributable to the flip).

**Checkpoint P3**: `pnpm typecheck && pnpm lint && pnpm test` green; the config-source matrix passes; feature 001–004 suites stay green. **STOP** — do not start Phase 4 until green.

---

## Phase 4: Dashboard API backend (US1/US2/US4) — guard, Jira read surface, workspaces + agents endpoints, rotation seam

**Goal**: the guarded `/api/*` dashboard REST surface is live — verify-before-persist workspace create, statuses source, agent CRUD with the server-authoritative linter, test-run, token rotation with the memoized-client invalidation seam closed, and the SPA served statically without shadowing `/api`/`/health`. Every endpoint lands with its integration test. **⚠️ Blocks the frontend (Phases 5–8).**

- [X] T132 [US1] Implement `apps/backend/src/dashboard/dashboard-token.{provider,guard}.ts`: provider resolves `BRIGADIR_DASHBOARD_TOKEN` via `useFactory` (fail-fast, no default — Constitution lazy-resolution); `DashboardTokenGuard` extracts the `Authorization: Bearer` header and compares against the token with **`crypto.timingSafeEqual`** on equal-length buffers (constant-time; length-mismatch is an immediate reject without leaking timing). Add the key to `test/integration/harness.ts` (one place). **Verify**: unit test — valid token passes; wrong token and missing header reject; comparison uses `timingSafeEqual` (grep) and guards against length mismatch.
- [X] T133 [US1] **[Mandatory — dashboard guard, task (g)]** Integration test `test/integration/dashboard-auth.spec.ts`: a `/api/workspaces` call **without** a bearer → 401; with a **wrong** bearer → 401; with the correct bearer → 200. Assert the **callback routes** `/api/callbacks/runs/:runId/*` are **NOT** behind the dashboard guard (they still use `RunTokenGuard`) — a dashboard token must not authorize a callback, and a run token must not authorize `/api/workspaces`. Note the constant-time comparison in the test description. **Verify**: `pnpm test:integration test/integration/dashboard-auth.spec.ts` green.
- [X] T134 [US1] Extend the Jira read surface: add `getMyself(): { displayName }` (`GET /myself`, identity for Verify) and `getProjectStatuses(projectKey): { id, name, statusCategory }[]` (`GET /rest/api/3/project/{projectKey}/statuses`, **flattened + de-duped by id** — research R3) to `jira-client.interface.ts`, `basic-auth-jira.client.ts`, and `lazy-jira.client.ts`. **Verify**: unit test against a faked HTTP layer — `getProjectStatuses` flattens statuses grouped by issue type and de-dupes by id into a flat list (no columns); `getMyself` returns the display name.
- [X] T135 [US1] Add `libs/jira/src/jira-client-factory.ts` — `JiraClientFactory.fromCredentials({ siteUrl, email, apiToken }) → JiraClient` building a throwaway `BasicAuthJiraClient` from **explicit candidate** credentials (never the memoized `JIRA_CLIENT`). Backs wizard Verify (pre-persist) and rotation re-verify. **Verify**: unit test — the factory builds a working client from explicit creds without reading the DB; verifying candidate creds never touches the workspaces row.
- [X] T136 [US2] Add `libs/jira/src/statuses.service.ts` — `StatusesService.get(workspaceId, { refresh }) → BoardStatus[]`: resolves the workspace's `project_key`, calls `getProjectStatuses`, caches in-memory per workspace (**5-min TTL**); `refresh:true` bypasses/repopulates the cache (agent-form open, FR-011); an upstream failure surfaces a typed `StatusesUnavailable` (→ 502) rather than an empty/stale list. **Verify**: unit test — a second call within TTL hits the cache (one Jira call); `refresh:true` forces a re-fetch; an upstream throw propagates as `StatusesUnavailable`.
- [X] T137 [US4] Close the **rotation-invalidation seam (research R6)**: replace `LazyJiraClient`'s write-once memo with a **fingerprint-checked** memo — the `jira.module.ts` resolver reads a cheap credential fingerprint (the workspaces row `updated_at`, or a hash of `jira_credentials`) alongside the client; on each resolution the fingerprint is re-checked and the client **rebuilt** when it changed. Preserves the single-workspace `.limit(1)` assumption (multi-workspace keying noted, not built). A failed resolution stays non-memoized (existing retry behavior). **Verify**: unit test — first call builds a client; a second call with an **unchanged** fingerprint reuses it (no rebuild); a changed fingerprint triggers a rebuild with the new credentials.
- [X] T138 [US4] **[Mandatory — rotation E2E, task (e)]** Integration test `test/integration/token-rotation.spec.ts` (testcontainers + mock Jira, backend + worker): warm the worker-side `LazyJiraClient` with a first Jira call using credentials A → rotate the token to B via `PUT /api/workspaces/:id/jira-connection` → assert the **next** worker reconcile/Jira call authenticates with **B**, not the stale A (fingerprint rebuild across the process boundary), and the stored blob is the new `0x01` envelope + updated `expires_at`. **Verify**: `pnpm test:integration test/integration/token-rotation.spec.ts` green.
- [X] T139 [US1] Implement `apps/backend/src/dashboard/workspaces.controller.ts` — `GET /api/workspaces` (list, credentials never serialized, `credential_status` derived), `POST /api/workspaces/verify` (pre-persist, via `JiraClientFactory` → bot/project/board_type; board id extracted from URL; path-qualified 422 distinguishing `token_invalid` vs `board_forbidden` vs `board_unparseable`), `POST /api/workspaces` (**server re-runs Verify** before writing; on success persists name/site/project_key/board_id/board_type/**encrypted** creds/`expires_at`/ordered `repositories`). All behind `DashboardTokenGuard`. **Verify**: integration test `test/integration/workspace-wizard.spec.ts` — verify surfaces identity on a good token; bad token → 422 at `jira_api_token`; inaccessible board → **distinct** 422 at `board`; board URL → id extracted; create re-validates server-side and a board made inaccessible between verify and create → 422 with **no row** written; a created workspace has an `0x01`-encrypted blob (US1 acceptance 1–6, SC-002/009).
- [X] T140 [US2] Add `GET /api/workspaces/:id/statuses` (via `StatusesService`, `?refresh=true` force-refresh) returning the flat `{ id, name, statusCategory }[]`; upstream failure → **502 `statuses_unavailable`** (form blocks status editing, spec edge case). **Verify**: integration test — returns the mock-Jira flat status set; `?refresh=true` re-fetches; simulated upstream failure → 502 with `statuses_unavailable` (no empty/stale 200).
- [X] T141 [US4] Add `PUT /api/workspaces/:id/settings` (scope_jql / branch_prefix / repositories — persist, take effect next pass) and `PUT /api/workspaces/:id/jira-connection` (rotate: re-verify live via `JiraClientFactory`, replace encrypted creds + `expires_at`, invalidate the memo via T137) to the workspaces controller; derive the expiry badge state (`warn_30` at ≤30d, `warn_7` at ≤7d, `expired` past) in the list/detail response. **Verify**: integration test `test/integration/workspace-settings-rotate.spec.ts` — rotation replaces the blob + `expires_at` (re-verify failure keeps the old creds, 422); settings edits persist; with a controllable clock, `expires_at` at 25d → `warn_30`, 5d → `warn_7`, past → `expired` (US4 acceptance, SC-008).
- [X] T142 [US2] Implement `apps/backend/src/dashboard/agents.controller.ts` — `GET /api/agents?workspace=`, `POST /api/agents`, `PUT /api/agents/:id` (**run `lintAgent` server-side against the live board statuses before writing**: blocking errors → 422 with path-qualified `issues`, nothing written; `status_cycle` → 201/200 with `warnings[]`), `DELETE /api/agents/:id` (soft = `enabled=false` when the agent has ≥1 run; hard delete when zero runs). Status selections bind id+name (`behavior.status_ids`). **Verify**: integration test `test/integration/agent-crud.spec.ts` — a `status_success` absent from the board → 422 `status_absent` at the field; a second **enabled** agent with a duplicate `trigger_status` and no distinguishing `trigger_jql` → 422 `duplicate_trigger`, **allowed** with a distinct `trigger_jql`; a cycle → 201 + `status_cycle` warning; delete of an agent with runs → soft, without runs → hard (US2 acceptance 1–5, 8; SC-004). (Server enforcement complements the pure-matrix unit test T120.)
- [X] T143 [US2] Add `POST /api/agents/:id/test-run` — reuse the existing manual-run path (`RunTriggerService.trigger`, `triggerEvent.source='manual'`) against the given `ticket_key`, honoring the three-level dedup (spec Assumption; does **not** bypass idempotency). **Verify**: integration test — a test-run enqueues a run for that agent/ticket; a second immediate test-run for the same (ticket, agent) returns `deduplicated` (the `runs_one_active` guard), not a second active run (US2 acceptance 6).
- [X] T144 [US2] **[Mandatory — hot-reload FR-026, task (f)]** Integration test `test/integration/hot-reload.spec.ts`: create an agent via `POST /api/agents` (no restart), then drive **one** poller/reconcile pass → assert the ticket in the new agent's `trigger_status` triggers a run using the new config; likewise edit an agent's config and assert the next pass uses the edited values — all with **no backend/worker restart** (FR-026, SC-006). **Verify**: `pnpm test:integration test/integration/hot-reload.spec.ts` green.
- [X] T145 Wire `@nestjs/serve-static` in `apps/backend/src/app.module.ts` to serve `apps/web/dist` at `/` with SPA fallback to `index.html`, **ordered after** the `/api/*` controllers and `/health` so it never shadows them; add the dep. **Verify**: integration/e2e test — `GET /health` and `GET /api/workspaces` (with bearer) resolve to their handlers (not `index.html`); an unknown client route (`/workspaces/new`) returns `index.html`; a missing static asset under `/assets/...` 404s rather than returning `index.html` for `/api`.

**Checkpoint P4**: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` green; every dashboard endpoint answers behind the guard; rotation invalidates the memo across processes; SPA fallback does not shadow `/api`/`/health`. **STOP** — do not start the frontend until green.

---

## Phase 5: Frontend scaffold (US1/US2) — apps/web + test harness

**Goal**: a boring, standard Vue 3 + Vite + Element Plus + Pinia + TanStack Query app exists, calls the backend through a typed bearer-injecting client, and has a component-test harness with msw. **⚠️ Blocks the wizard/agents/settings UIs (Phases 6–8).**

- [ ] T146 Scaffold `apps/web` (Vue 3 + Vite + TypeScript `strict`): `package.json` (`@brigadir/web`, scripts `dev`/`build`/`test`), Vue Router, Pinia, Element Plus, `@tanstack/vue-query`; `vite.config.ts` with `server.proxy` mapping `/api` → `http://localhost:3000` (dev only); base `views`/`router` with `WorkspaceList` + placeholder `Runs`/`HumanQueue` routes. Covered by the existing `apps/*` pnpm glob; **kept out of `nest-cli.json`** and off `nest build`. **Verify**: `pnpm install` exits 0; `pnpm --filter @brigadir/web build` emits `apps/web/dist/index.html`; `pnpm --filter @brigadir/web dev` serves and proxies `/api` to :3000; `nest build backend` does not attempt to build `apps/web`.
- [ ] T147 Implement `apps/web/src/api/` — a typed `apiClient` (fetch wrapper injecting `Authorization: Bearer <token>` from a runtime/build-provided value, parsing the shared error shape into typed errors), resource modules (`workspaces`, `statuses`, `agents`) using `@brigadir/contracts` types, and TanStack Query composables (`useWorkspaces`, `useStatuses`, `useAgents`, mutations) with stable query keys. **Verify**: unit test — the client attaches the bearer header, and a 422 error body maps to a typed error carrying `issues[]` (path-qualified) for the forms to consume.
- [ ] T148 Add the component-test harness `apps/web/test/`: Vitest (jsdom) config, an msw `setupServer` with default `/api/*` handlers (`beforeAll`/`resetHandlers`), and a `mountWithProviders(component, { props })` helper installing `VueQueryPlugin` (retries off), a fresh Pinia, and Element Plus. **Verify**: `pnpm --filter @brigadir/web test` runs a trivial smoke component test that mounts through the harness and reads a faked `/api/workspaces` response via msw.

**Checkpoint P5**: `apps/web` builds, dev-proxies to the backend, and the msw+@vue/test-utils harness runs a smoke test. **STOP** — do not start the forms until green.

---

## Phase 6: Workspace wizard UI (US1) 🎯 MVP

**Goal**: a team member creates a workspace end to end through the wizard — name → live Verify (bot/project/board type) → repositories → done — with `expires_at` defaulting to +1 year and inline, field-attached errors.

**Independent Test** (spec.md): with msw faking `/api/*`, drive the wizard; Verify surfaces identity from a valid token, a bad token/board is rejected inline, and finish issues the create call with the encrypted-on-server payload.

- [ ] T149 [US1] Build `apps/web/src/components/WorkspaceWizard/` (Element Plus `el-steps`): step 1 name; step 2 Jira connection (site URL + email + API token with the `id.atlassian.com` hint + **`expires_at` defaulting to +1 year from today**, the Atlassian max, with the copy-the-date hint) + a board field accepting id **or** URL + a **Verify** button; step 3 repositories (`{name, git_url, default_branch}`, first = default); step 4 completion. **Verify**: mounts through the harness; the token field shows the create-at-`id.atlassian.com` hint; `expires_at` pre-fills to today+1y.
- [ ] T150 [US1] Wire step 2 **Verify** to `POST /api/workspaces/verify` and finish to `POST /api/workspaces`: on success render the resolved bot display name, project key, and board type and enable advancing; on a 422 attach the message to the offending field (token vs board) and block advancing; extract-from-URL is server-side, so a pasted board URL round-trips. **Verify**: covered by T151.
- [ ] T151 [US1] Component test `apps/web/test/workspace-wizard.spec.ts` (Vitest + @vue/test-utils + msw): valid token+board → identity renders and **Next** enables (US1 #1); `422 {path:["jira_api_token"],code:"token_invalid"}` → error binds to the token field, Next stays disabled (US1 #3); `422 {path:["board"],code:"board_forbidden"}` → a **board-distinct** message, not a token message (US1 #4); a pasted board URL → the value sent to `/verify` is what the user pasted (server extracts the id, US1 #2); the create body carries the +1y `expires_at` default when unchanged. **Verify**: `pnpm --filter @brigadir/web test workspace-wizard` green.

**Checkpoint P6 — MVP**: a workspace is created through the UI against a faked (and, in T158, real) Jira with credentials encrypted server-side. **STOP** and validate US1 independently.

---

## Phase 7: Agents UI (US2)

**Goal**: agent CRUD through the form — status fields populated entirely from the board's flat list, the mini-linter mirrored client-side for immediate feedback with the server authoritative on save, and a test-run by ticket key.

**Independent Test** (spec.md): with msw faking `/api/*` (statuses + agents), create/edit an agent; assert the status selects come from the API, linter errors attach per field, and the cycle warning is non-blocking.

- [ ] T152 [US2] Build `apps/web/src/views/AgentsList.vue` + `components/AgentForm/`: the full field set (name, instruction, executor+model [`claude_cli`], `trigger_status`, `status_running` [recommended-by-default], `status_success`, `status_failure`, `timeout_minutes`, `max_budget_usd`, `max_attempts`, `trigger_jql` [advanced], repository select [empty = workspace default], behavior `branch_prefix`/`allowed_tools`/`required_checks`, use-callback-channel toggle). **All status fields are `el-select`s populated from `GET /api/workspaces/:id/statuses`** (flat, no columns), binding id+name; the form force-refreshes statuses on open and blocks status editing if statuses are unavailable (502). A **test-run by ticket key** button calls `POST /api/agents/:id/test-run`. **Verify**: mounts; status selects list exactly the faked flat set; a 502 statuses response disables the status fields with a visible reason.
- [ ] T153 [US2] Mirror the linter client-side by importing `lintAgent` from `@brigadir/contracts` (the **same** function the server enforces — T120), attaching each error to its field for immediate feedback while leaving the server authoritative on save (a server 422 re-pins any issue the client missed). **Verify**: covered by T154.
- [ ] T154 [US2] Component test `apps/web/test/agent-form.spec.ts` (Vitest + @vue/test-utils + msw): status fields populated from the faked `/statuses` (no columns, US2 #1); a `status_success` not in the set is flagged **immediately** by the client mirror and, on submit, a `422 status_absent` keeps it pinned (US2 #2/#9); a duplicate `trigger_status` among enabled agents flags client-side and `422 duplicate_trigger` on save, then a distinct `trigger_jql` allows save (US2 #3/#4); a cycle shows a **non-blocking** `status_cycle` warning yet submit still succeeds (US2 #5). **Verify**: `pnpm --filter @brigadir/web test agent-form` green.

**Checkpoint P7**: agent CRUD + the mirrored/authoritative linter + test-run work through the UI against faked APIs. **STOP** and validate US2 independently.

---

## Phase 8: Workspace settings UI (US4)

**Goal**: the settings screen rotates the token (re-verified), shows the expiry badge with 30/7-day warning states, and edits `scope_jql`, default `branch_prefix`, and the repositories list.

- [ ] T155 [US4] Build `apps/web/src/views/WorkspaceSettings.vue`: token reconnect/rotation (re-verify via the same step-2 flow, calling `PUT /api/workspaces/:id/jira-connection`), the `expires_at` **badge** with `warn_30`/`warn_7`/`expired` states from the server-derived `credential_status`, `scope_jql` (advanced), default `branch_prefix` (`feat`), and repositories-list management (`PUT …/settings`). No workspace-pause control (data-model.md: not a one-field flip → deferred). **Verify**: mounts; the badge renders each state from the `credential_status` field; rotation posts the new token + `expires_at`.
- [ ] T156 [US4] Component test `apps/web/test/workspace-settings.spec.ts` + placeholder routes: assert the badge shows `warn_30` at 25d, `warn_7` at 5d, `expired` past (driven by faked `credential_status`); a rotation re-verifies then persists (msw), and a re-verify 422 surfaces inline without clearing the stored connection; the `Runs`/`HumanQueue` routes render a placeholder (iteration-6 stub). **Verify**: `pnpm --filter @brigadir/web test workspace-settings` green.

**Checkpoint P8**: settings/rotation/expiry-badge/repositories work through the UI. **STOP** and validate US4 independently.

---

## Phase 9: Polish & Cross-Cutting — full-suite checkpoint, manual acceptance, DoD journal

- [ ] T157 Full-suite checkpoint: `pnpm typecheck && pnpm lint && pnpm test` (unit + contracts) **and** `pnpm --filter @brigadir/web test` (frontend component tests) green, then **4 consecutive** `pnpm test:integration` runs green (flake gate — CLAUDE.md rules 1/6). Fix any ordering/namespace flake before proceeding. **Verify**: paste the 4 green integration run summaries; static sweep confirms **no `${VAR}` secret interpolation** anywhere (grep `credentials.codec`, `dashboard`, executor config) and that credentials are never serialized in an API response (grep the dashboard responses).
- [ ] T158 Manual acceptance click-through (`docker compose up --build`, the UI acceptance gate this iteration — doubles as the first real UI onboarding, replacing the old `scripts/provision-live.mjs` path): create a **real** workspace through the wizard against the operator's real Jira (verify surfaces the real bot/project/board type in <5 min, SC-001), add one agent with board-populated status selects (<2 min, SC-003), trigger a test-run by ticket key, and confirm the agent is picked up on the next poller pass with **no restart** (SC-006). **Verify**: record the workspace id, the created agent, and the run id + observed transition; note the `BRIGADIR_CREDENTIALS_KEY`/`BRIGADIR_DASHBOARD_TOKEN` were required at boot (no plaintext fallback).
- [ ] T159 Append the iteration-5 entry to `docs/progress.md`: the DB-authoritative flip (insert-if-absent + registry queues + yaml-optional boot), AES-256-GCM credentials at rest + boot migration + the boot-required key posture, the dashboard REST surface + shared bearer guard (separate from the run-token guard), the `LazyJiraClient` rotation-invalidation seam and how it was closed, and the first `apps/web` dashboard (wizard + agents + settings). Note the deferred workspace-pause control (no one-field flip) and Runs/human-queue as iteration-6 placeholders. **Verify**: the entry names the constitution touchpoints (Principle V at-rest now satisfied; Principle I unaffected — the flip is config, not ticket status) and links the SC IDs proven by T130/T138/T144/T151/T154/T156/T158.

**Checkpoint P9 — Definition of Done**: full suite ×4 green + frontend tests green; a real workspace + agent created through the UI with encrypted credentials and hot pickup; progress journal updated. **STOP** — iteration complete.

---

## Dependencies & Execution Order

### Phase dependencies
- **Phase 1 (Setup)** — no deps. Blocks Phases 4–8 (shared DTOs + linter).
- **Phase 2 (US5 credentials)** — needs Phase 1; blocks US1 create (Phase 4/6) since the wizard persists a real token.
- **Phase 3 (US3 flip)** — needs the DB layer; independent of Phase 2; blocks nothing UI but must land before Phase 9 (regression gate) and is a prereq for a yaml-free operator.
- **Phase 4 (dashboard API)** — needs Phases 1–2 (codec + linter + DTOs); T137 before T138; T134/T135/T136 before T139/T140/T141; blocks Phases 5–8.
- **Phase 5 (scaffold)** — needs Phase 4 (endpoints to call/fake); blocks Phases 6–8.
- **Phases 6/7/8** — each needs Phase 5; mutually parallel (distinct components), each gated on its Phase-4 endpoints.
- **Phase 9** — needs everything.

### Critical task edges
- **T122 (key provider, boot-required)** blocks T123/T125/T126 and the whole credential path.
- **T120 (pure linter)** blocks T142 (server enforcement) and T153 (client mirror).
- **T129 (registry queues)** + **T127/T128 (seeder/yaml-optional)** block T130 and the T131 regression gate.
- **T137 (fingerprint memo)** blocks T138 (rotation E2E) and T141 (rotate endpoint).
- **T134/T135/T136 (Jira read surface + factory + statuses cache)** block T139/T140/T141.
- **T145 (serve-static)** depends on `apps/web` build existing conceptually but is asserted independently; it must land before T158.

### Parallelizable
- **Within Phase 1**: T119, T120, T121 (distinct files).
- **Within Phase 2**: T124 alongside T125 once T123 lands.
- **Within Phase 4**: T134/T135/T136 in parallel; T132/T133 (guard) in parallel with the Jira read surface.
- **Across Phases 6/7/8**: the three UIs are mutually parallel once Phase 5 is done.

---

## Parallel Execution Examples

```bash
# Phase 1 (all parallel):
Task T119: dashboard DTOs + error shape (packages/contracts)
Task T120: pure mini-linter + matrix unit tests (packages/contracts)
Task T121: WorkspaceSettings.repositories[] typing + accessor

# Phase 2 (after Phase 1):
Task T122: credentials-key provider (boot-required both apps) + harness key
#   then: Task T123 codec  →  Task T124 codec unit tests (parallel with) Task T125 boot migration
Task T126: legacy-migration E2E

# Phase 4 (after Phases 1–2):
Task T132 → T133 (guard + auth test)   ||   Task T134, T135, T136 (Jira read surface)
Task T137 → T138 (fingerprint memo → rotation E2E)
# then endpoints: T139 (workspaces) , T140 (statuses) , T141 (settings/rotate) , T142 (agents+linter) , T143 (test-run) , T144 (hot-reload) , T145 (serve-static)

# Phases 6/7/8 (after Phase 5) — mutually parallel:
Task T149→T150→T151 (wizard)   Task T152→T153→T154 (agents)   Task T155→T156 (settings)
```

---

## Implementation Strategy

### MVP scope
**US1 (workspace wizard + verified create) is the MVP** — reached at the end of Phase 6, where a team member onboards a real Jira project through the UI with credentials encrypted at rest. It requires Phases 1 → 2 (US5 is its enabling cross-cut — real tokens must be encrypted before the wizard persists one) → the workspace slice of Phase 4 → Phase 5 → Phase 6.

### Incremental delivery
1. Phase 1 → shared linter + DTOs + repositories typing unit-pass standalone.
2. Phase 2 → credentials encrypted at rest, key boot-required, legacy blobs migrated (US5).
3. Phase 3 → DB-authoritative config flip, yaml optional, registry queues (US3); 001–004 stay green.
4. Phase 4 → guarded dashboard API: verified create, statuses, agent CRUD + linter, test-run, rotation seam closed, SPA served without shadowing.
5. Phase 5 → `apps/web` scaffold + msw test harness.
6. Phase 6 → wizard (US1 / MVP).
7. Phase 7 → agents UI + mirrored linter (US2).
8. Phase 8 → settings + expiry badge + rotation (US4).
9. Phase 9 → full suite ×4, real-Jira manual onboarding, DoD journal.

### Independent test criteria (per story)
- **US1**: verify surfaces bot/project/board type; bad token/board rejected inline (distinctly); server re-validates and refuses to persist on a between-verify-and-save failure; created blob is `0x01`-encrypted (T139, T151).
- **US2**: statuses come from the flat board list; linter blocks missing-status + duplicate-trigger (unless `trigger_jql` differs) client- and server-side; cycle warns non-blocking; soft/hard delete; test-run honors dedup (T120, T142, T143, T154).
- **US3**: empty-DB imports once / DB-wins on differing rows / yaml-absent boots / queues == registry (T130); 001–004 green (T131).
- **US4**: rotation replaces the encrypted blob + `expires_at` and the worker picks up the new token next pass; badge at 30/7/expired thresholds (T138, T141, T156).
- **US5**: non-plaintext storage, transparent decrypt-and-authenticate, legacy migration on boot, fail-fast on missing key (T124, T126).

### Notes
- Tests are **mandatory** for every pipeline/logic task (Constitution VI); each backend layer ships its integration test in its own phase — no end-of-project test batch. UI ships component tests for the two critical forms (R1); the manual click-through (T158) is the UI acceptance gate this iteration.
- The **mandatory dedicated tasks** are: codec units **T124 (a)**, legacy-migration E2E **T126 (b)**, DB-vs-yaml matrix **T130 (c)**, linter matrix **T120 (d)**, rotation E2E **T138 (e)**, hot-reload **T144 (f)**, dashboard guard **T133 (g)** — each its own line item.
- **No `${VAR}` secret interpolation** anywhere (T157 sweep); `BRIGADIR_CREDENTIALS_KEY` is **boot-required for both apps** (no plaintext regime); the SPA fallback never shadows `/api`/`/health` (T145); the seeder flip keeps 001–004 fixtures green (T131).
- **No DB migration** this iteration — every column already exists in architecture §3 (data-model.md); CLAUDE.md rule 5 is not triggered.

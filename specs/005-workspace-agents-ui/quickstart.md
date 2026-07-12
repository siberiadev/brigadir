# Quickstart: Workspace & Agents UI (Feature 005)

Validation guide — how to prove the feature works end to end. Implementation bodies
live in the code + `tasks.md`, not here.

## Prerequisites / env

Backend (new this iteration):
- `BRIGADIR_CREDENTIALS_KEY` — 32-byte base64/hex (AES-256-GCM). **Boot fails** if a
  credential op runs without it (FR-023).
- `BRIGADIR_DASHBOARD_TOKEN` — shared dashboard bearer (FR-001/FR-003).
- (existing) `DATABASE_URL`, `REDIS_URL`, `BRIGADIR_JWT_SECRET`; `AGENTS_CONFIG_PATH`
  now **optional** (FR-019).

Add both to `.env.example`. Frontend dev server: `pnpm --filter @brigadir/web dev`
(Vite on :5173, proxying `/api` → :3000).

## Frontend test pattern (the reusable recipe)

Component tests: **Vitest + @vue/test-utils + jsdom + msw**. The pattern for the two
critical forms:

1. **Fake the API with msw**, not the store. Define `http.post('/api/workspaces/verify',
   …)`, `http.get('/api/workspaces/:id/statuses', …)`, `http.post('/api/agents', …)`
   handlers per test; start an msw `setupServer` in `beforeAll`, `resetHandlers` in
   `afterEach`. This keeps tests at the real HTTP boundary (mirrors the backend's
   testcontainers discipline for the API).
2. **Mount with a TanStack Query + Pinia + Element Plus test harness.** A
   `mountWithProviders(component, { props })` helper installs `VueQueryPlugin` (with
   retries off), a fresh Pinia, and Element Plus, so queries/mutations run against msw.
3. **Drive, then assert on rendered state**, not internals.

### Critical form 1 — Wizard step 2 (Verify)
- valid token+board → msw returns bot/project/board_type → assert the resolved identity
  renders and **Next** enables (Acceptance US1 #1).
- msw returns `422 { path:["jira_api_token"], code:"token_invalid" }` → assert the error
  binds to the token field and Next stays disabled (US1 #3).
- msw returns `422 { path:["board"], code:"board_forbidden" }` → assert a board-distinct
  message, not a token message (US1 #4).
- paste a board URL → assert the extracted id is what gets sent (US1 #2).

### Critical form 2 — Agent form (linter mirror)
- msw `statuses` returns a known flat set → assert every status field is a select of
  exactly those, no columns (US2 #1).
- pick `status_success` not in the set → **client mirror** flags it immediately
  (US2 #9); on submit, msw `422 status_absent` keeps it pinned (US2 #2).
- second enabled agent, same `trigger_status`, no `trigger_jql` → mirror + msw
  `422 duplicate_trigger` (US2 #3); give it a distinct `trigger_jql` → save allowed
  (US2 #4).
- cycle setup → **non-blocking** `status_cycle` warning shows but submit still succeeds
  (US2 #5).

Client and server share the **same linter function** from `packages/contracts`
(imported by both), so the mirror can't drift from the authority (FR-012).

## Backend validation scenarios (testcontainers + mock Jira)

Existing pattern: `test/integration` with real Postgres/Redis (testcontainers), Jira
faked (mock-jira / msw). Per-suite `BULLMQ_PREFIX` (CLAUDE.md rule 6).

1. **Credentials at rest (US5 / R2, `contracts/credentials-codec.md`):** create a
   workspace → read the raw `jira_credentials` bytes, assert byte[0]===`0x01` and no
   `email` substring; assert the system authenticates to mock Jira by decrypting;
   seed a legacy `{…}` plaintext blob → boot migration re-encrypts it, auth still works;
   unset `BRIGADIR_CREDENTIALS_KEY` → encrypt/encrypted-decrypt fail-fast.
2. **Wizard Verify + create (US1):** `POST /verify` surfaces bot/project/board_type on a
   good token; bad token → `422` at `jira_api_token`; inaccessible board → distinct
   `422` at `board`; board URL → id extracted. `POST /workspaces` **re-validates**
   server-side; a board made inaccessible between verify and create → `422`, **no row**.
3. **Agent CRUD + linter matrix (US2):** missing status → `422 status_absent`; duplicate
   trigger among enabled → `422 duplicate_trigger`, allowed with distinct `trigger_jql`;
   cycle → `201` + `status_cycle` warning. Status fields bind id+name (`status_ids` in
   behavior). Delete: agent with runs → soft (`enabled=false`); without → hard.
4. **Source-of-truth flip (US3 / R4):** (a) empty DB + yaml → rows imported; (b) DB rows
   differ from yaml → **DB unchanged** after boot; (c) yaml absent → boot OK on DB
   config; (d) assert the run-queue set == `EXECUTOR_TYPES` registry (`run.mock`,
   `run.claude_cli`) regardless of yaml/agent contents (SC-007).
5. **Hot-reload (US2 #7 / FR-026 / SC-006):** create/edit an agent via the API, then run
   one reconcile pass → assert the new config is used with **no restart**.
6. **Rotation invalidates the memoized client (R6 seam):** with a workspace whose memo
   is warmed by a first Jira call, rotate the token → assert the **next** Jira call uses
   the new credentials (fingerprint-checked memo rebuild), not the stale client.
7. **Expiry badge (US4 / SC-008):** with a controllable clock, `expires_at` at 25d → 
   `warn_30`; at 5d → `warn_7`; past → `expired`.
8. **Dashboard auth (R5):** `/api/*` without the bearer → `401`; callbacks route still
   uses the run-token guard (unaffected).

## Manual click-through (the UI acceptance gate this iteration)

`docker compose up --build`, open the dashboard, run: wizard → verify a real board →
add a repo → finish (SC-001, <5 min); open Agents → add an agent with board-populated
status selects → save (SC-003, <2 min); trigger a test-run by ticket key. No file edits.

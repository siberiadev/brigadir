# Research: Workspace & Agents UI (Feature 005)

**Branch**: `005-workspace-agents-ui` | **Date**: 2026-07-12

All decisions below resolve the six research priorities from the plan brief. Format
per priority: **Decision / Rationale / Alternatives rejected**. Where an existing
codebase seam already covers the need, the file is cited so `/speckit-tasks` can
extend rather than reinvent.

---

## R1 — First frontend app: `apps/web` (Vue 3 + Vite + TS)

**Decision.** Add a non-Nest workspace package `apps/web` (Vue 3 + Vite + TypeScript,
`strict: true`) under the existing pnpm `apps/*` glob. Stack: **Element Plus** (UI),
**Pinia** (client state), **TanStack Query** (`@tanstack/vue-query`, server cache),
**Vue Router** (screens). Component tests: **Vitest + @vue/test-utils + jsdom + msw**
(`msw` is already a root devDependency, pinned `2`). No E2E this iteration (spec Out
of Scope).

- **Dev server → backend proxy.** `vite.config.ts` `server.proxy` maps `/api` →
  `http://localhost:3000`. The SPA always calls same-origin `/api/*`; the proxy is a
  dev-only convenience so the browser never learns the backend host. No CORS needed in
  dev because the proxy makes requests same-origin from the browser's view. (Backend
  still gets a permissive dev CORS as belt-and-suspenders — see R5.)
- **Production build & serving — serve static from the backend (single container).**
  `vite build` emits `apps/web/dist`. The Nest backend serves it via
  `@nestjs/serve-static` (new dependency) mounted at `/`, with SPA fallback to
  `index.html` for client-side routes, and `/api/*` + `/health` taking precedence.
  The `Dockerfile` gains a web build stage (`pnpm --filter @brigadir/web build`) whose
  `dist` is copied next to the backend bundle; `docker-compose` needs no new service.
- **Boring conventions.** `apps/web/src/{api,components,composables,stores,views,router}`.
  One typed `apiClient` (fetch wrapper that injects the bearer token from a
  build/runtime-provided value and throws typed errors). TanStack Query keys per
  resource (`['workspaces']`, `['workspace', id, 'statuses']`, `['agents', workspaceId]`).
  The two critical forms (wizard step-2 Verify, agent form) get component tests with
  msw faking `/api/*`.

**Rationale.** Element Plus/Pinia/TanStack/Vite are the stack already fixed by
decision #4 and `docs/spec.md §1.6`; the constitution names Vue for the dashboard.
Serving static from the backend keeps the deployment a single image and avoids a
second container + reverse-proxy config for an internal tool. msw is already vendored,
so API faking has zero new tooling cost.

**Alternatives rejected.**
- *Separate nginx/static container.* More infra for an internal single-node tool; the
  backend already terminates HTTP and owns auth — one origin is simpler and removes a
  cross-origin surface.
- *testing-library/vue instead of @vue/test-utils.* Either works; `@vue/test-utils` is
  the Vue-native default and pairs cleanly with Element Plus stubs. Not worth a second
  opinionated dependency.
- *Making `apps/web` a Nest project in `nest-cli.json`.* It is a Vite app, not a Nest
  build target; it must stay out of `nest-cli.json` and off the `nest build` path.

---

## R2 — Credentials codec: AES-256-GCM + legacy migration

**Decision.** Upgrade `libs/jira/src/credentials.codec.ts` from plaintext-JSON to
**AES-256-GCM**, keeping the same function seam (`encodeJiraCredentials` /
`decodeJiraCredentials`) so no caller changes.

- **Envelope** (`bytea`): `version(1 byte = 0x01) || iv(12 bytes) || authTag(16 bytes)
  || ciphertext`. Cipher `aes-256-gcm` via `node:crypto`; the plaintext is the same
  `JSON.stringify({email, api_token})` as today.
- **Key** from `BRIGADIR_CREDENTIALS_KEY` (32 bytes; accept base64 or hex, validate
  decoded length === 32). Resolved in a **DI factory / provider** (mirrors
  `jwt-secret.provider.ts`), never at `@Module()` composition (constitution lazy
  resolution). **Fail-fast (FR-023):** any encrypt, or any decrypt of an
  encrypted-format blob, with the key absent/wrong-length throws a clear
  `CredentialsKeyMissingError` — never a silent plaintext fallback.
- **Transparent, format-sniffing decode.** `decodeJiraCredentials` inspects the first
  byte: `0x01` → GCM decrypt path (requires key); a leading `{` (0x7b) → legacy
  plaintext-JSON path (the current format). Both yield `JiraCredentials`. This
  guarantees *"never lose the ability to authenticate"* — a workspace stays usable the
  instant this code deploys, before any migration runs. The iteration-1 placeholder
  bytes still fail validation (not JSON `{…}`, not a `0x01` envelope) exactly as today.
- **Legacy migration — one-shot at boot + opportunistic on write.** A boot step
  (backend `main.api.ts`, after migrations/seed) scans `workspaces`, and for every row
  whose `jira_credentials` is legacy plaintext, re-encrypts and rewrites it. Every
  write path (create, rotate, settings save) already calls `encodeJiraCredentials`, so
  new/rotated rows are encrypted by construction; the boot pass only cleans up
  pre-existing rows. Idempotent (already-encrypted rows are skipped by the version-byte
  sniff).

**Rationale.** Function-seam parity means the JiraModule resolver, seeder, and future
callers are untouched. Format-sniffing decode is the honest reading of the
constitution's *"never lose the ability to authenticate"*: authentication never
depends on the migration having run. Boot migration + write-path encryption together
satisfy the at-rest guarantee (FR-020/FR-022) without a DDL change (`bytea` is
format-agnostic).

**Alternatives rejected.**
- *Lazy migrate on first read only (no boot pass).* The natural read seam
  (`LazyJiraClient` resolver) is a read-only context; rewriting from there mixes a
  write into a hot read path and leaves untouched rows plaintext indefinitely. A boot
  pass is explicit and bounded.
- *Fail-fast even on legacy plaintext read when key absent.* Rejected: that would
  *lose the ability to authenticate* for an operator who upgraded the binary before
  setting the key — the opposite of the constitutional guarantee. Fail-fast applies to
  encrypt and to encrypted-blob decrypt; a plaintext legacy read is tolerated until the
  boot migration (which requires the key) runs.
- *DEK/KEK envelope or KMS.* Out of scope (spec: single env key, rotation tooling
  deferred).

**Schema note.** `workspaces.jira_credential_expires_at` and `jira_credentials bytea`
**already exist** (`workspaces.ts:18-19`, architecture §3). **No migration** is due for
credentials or expiry — see `data-model.md` for the explicit verdict.

---

## R3 — Statuses source (flat list for a board's project)

**Decision.** Add `getProjectStatuses(projectKey)` to the `JiraClient` interface,
implemented in `BasicAuthJiraClient` over **`GET /rest/api/3/project/{projectKey}/statuses`**.
That endpoint returns statuses grouped by issue type; we **flatten and de-duplicate by
status id** into `{ id, name, statusCategory }[]` — the flat, column-less list the
agent form and linter need (FR-010/FR-011, decision 2026-07-11). Expose it as
`GET /api/workspaces/:id/statuses`.

- **Cache.** In-memory per workspace (keyed by workspace id), TTL **5 minutes**, in a
  small `StatusesService`. **Force-refresh** via `?refresh=true` (the agent form issues
  this on open, FR-011 / edge "statuses source unavailable"). A fetch failure surfaces
  as a 502/`statuses_unavailable` so the form blocks status editing rather than showing
  an empty/stale list (spec edge case).

**Rationale.** The project-statuses endpoint is the documented way to get the statuses
*reachable for a project's issue types* — which is exactly the board's usable status
set — and is current in Atlassian Cloud REST v3. Flattening + de-duping by id yields
the "no columns" flat list. A short TTL keeps Jira calls bounded while a manual refresh
covers the "I just edited the workflow" case.

**Alternatives rejected.**
- *`GET /rest/agile/1.0/board/{id}/configuration`* (board columns → statuses). Returns
  statuses *grouped by column* — the exact columnar shape the product decision rejects,
  and omits statuses not mapped to a column.
- *`GET /rest/api/3/status`* (whole-instance status list). Too broad — every status in
  the Jira site, not the project's — and would offer the operator statuses the board
  can never be in.

---

## R4 — Seeder flip: insert-if-absent + registry-driven queues

**Decision.** Three coordinated changes make the DB authoritative and the yaml
optional:

1. **`ConfigSeeder` → insert-if-absent** (`libs/app-config/src/config-seeder.ts`).
   Replace every `onConflictDoUpdate` with existence-guarded inserts: workspace matched
   on `name`, executors/agents on the existing `UNIQUE(workspace_id, name)`. If a row
   exists, **do nothing** (DB wins, FR-017). Realizes the spec Assumption verbatim.
2. **yaml becomes optional at boot** (`agents-config.provider.ts`, `main.api.ts`). The
   provider returns `null` when the file is absent (only a *present-but-invalid* file
   fails fast). `main.api.ts` calls the seeder only when a config loaded; a missing
   `agents.yaml` is a clean boot on DB-only config (FR-019, US3 case c).
3. **`QueuesModule.register()` stops reading the yaml**
   (`libs/queues/src/queues.module.ts`). It provisions `run.<type>` for the **fixed
   executor-type registry** (`EXECUTOR_TYPES = ['mock', 'claude_cli']` from
   `@brigadir/contracts`) plus `reconcile`, regardless of yaml/agent contents
   (FR-018). This **removes the last composition-time `loadAgentsConfig()` from the
   worker** — `agents.yaml` is then fully optional at boot for both processes.

- **Queue-name composition-time read is preserved but re-sourced.** Static queue names
  are still needed at `registerQueue`/`@Processor` time (allowed by the constitution's
  lazy-resolution carve-out for *static structure*); the source flips from `config` to
  the constant `EXECUTOR_TYPES`, which is documented at the call site.
- **Existing suites still boot.** `run.mock` remains provisioned (mock is in the
  registry), so integration fixtures that enqueue mock runs are unaffected. Fixtures
  that set `AGENTS_CONFIG_PATH` still exercise the seeder's import branch.

**Rationale.** The registry — not the yaml — is the true set of executor types the
worker can run; deriving queues from it (a) guarantees `run.<type>` exists for every
supported type on boot (SC-007) and (b) severs the worker's last yaml dependency so
the DB is genuinely authoritative.

**Alternatives rejected.**
- *Keep deriving queues from the union of yaml + DB agents.* Fragile: a type with no
  current agent would have no queue, so creating the first agent of that type via the
  UI would enqueue to a missing queue. The registry is the stable source.
- *Delete the yaml importer entirely.* Rejected — FR-019 requires the existing
  operator's `agents.yaml` to keep working via the one-time import.

---

## R5 — Dashboard auth: shared bearer guard, separate from run-token

**Decision.** New `DashboardTokenGuard` (in a small dashboard-api module) that checks a
static shared bearer against **`BRIGADIR_DASHBOARD_TOKEN`**, resolved via a DI factory
provider (`dashboard-token.provider.ts`, mirroring `jwt-secret.provider.ts`;
fail-fast if unset — no dev default). It guards **all `/api/*` dashboard routes**
(`/api/workspaces*`, `/api/agents*`, statuses, test-run). Comparison is
**constant-time** (`crypto.timingSafeEqual` on equal-length buffers).

- **Explicitly separate from `RunTokenGuard`.** The callback guard
  (`libs/callback/src/run-token.guard.ts`) verifies a per-run JWT bound to `:runId` and
  a live run status; it stays on `/api/callbacks/*` only. The dashboard guard is a flat
  shared secret with no per-resource claims. The two never overlap: callbacks are
  agent→system, dashboard is operator→system.
- **CORS.** Dev: enable CORS for the Vite origin (`http://localhost:5173`) so a
  developer running `vite` directly (bypassing the proxy) still works; methods
  `GET,POST,PUT,DELETE`, `Authorization` header allowed. Prod: SPA is served
  same-origin from the backend, so CORS is effectively unused; keep it dev-gated.

**Rationale.** Internal tool, single trusted team, no accounts (FR-001) → a shared
bearer is the right weight. A dedicated guard + provider keeps it lazy-resolved and
structurally distinct from the run-token path, so neither can accidentally authorize
the other's routes.

**Alternatives rejected.**
- *Reuse `RunTokenGuard` for dashboard routes.* Category error — dashboard calls have
  no run context and no JWT; conflating them would weaken the run-token invariant.
- *No auth in dev.* Rejected — the guard is cheap and keeps dev/prod parity; the token
  is provided via env in both.

---

## R6 — Hot-reload audit + the LazyJiraClient rotation seam

**Audit result: config reads are already per-pass from the DB.** Verified paths:

| Path | Where | Reads from DB each pass? |
|------|-------|--------------------------|
| Poller scope / HWM / sprint | `poller.service.ts` (`getScopeJql`, `getReconcileState`) | ✅ per pass |
| Workspace + board type | `reconcile.service.ts:run()` (`select … from workspaces`) | ✅ per pass |
| Agent matching on status | `pipeline.service.ts:onStatusChanged()` (`select … from agents where trigger_status = … and enabled`) | ✅ per event |
| Dependency re-eval candidates | `reconcile.service.ts:reEvaluateDependencies()` (join `agents`) | ✅ per pass |
| Executor type / attempts at enqueue | `run-trigger.service.ts` (`select … from agents/executors`) | ✅ per trigger |

⇒ A workspace/agent created or edited through the UI is picked up on the next
poller/trigger pass with **no restart** (FR-026 / SC-006), and the source-of-truth
flip does not regress this. The one thing not read fresh is the **Jira client itself**.

**The seam (flagged for the plan): `LazyJiraClient` memoizes the built
`BasicAuthJiraClient`.** `libs/jira/src/lazy-jira.client.ts` caches `delegate` (the
resolved client) forever after first success; `jira.module.ts`'s resolver reads
`workspaces` with `.limit(1)` **once**. **Rotating a token updates the row but the
memoized client keeps authenticating with the OLD credentials** — and the memo lives in
the *worker* process while rotation happens in the *backend* process, so it is a
**cross-process invalidation** problem, not just an in-process one.

**Decision (recommended; finalized in `plan.md`).** Two moves:

1. **`JiraClientFactory` for explicit-credential clients.** Wizard **Verify** and token
   **rotation** must validate *candidate* credentials that are not yet persisted, so
   they build a throwaway `BasicAuthJiraClient` directly from the submitted
   `{siteUrl, email, apiToken}` — never through the memoized `JIRA_CLIENT`. This also
   backs the statuses fetch for a specific workspace.
2. **Fingerprint-checked memo for the runtime client.** Replace the write-once memo
   with a cache that stores a cheap **credential fingerprint** (e.g. the row's
   `updated_at`, or a hash of the `jira_credentials` bytes) alongside the client. On
   each resolution, a lightweight `select updated_at` (or the existing per-pass
   workspace read, threaded in) is compared; on change the client is **rebuilt**. This
   makes rotation take effect on the next reconcile pass in the worker *and* the next
   Jira call in the backend, across processes, because both re-read the row. The
   `.limit(1)` single-workspace assumption is preserved for this iteration (multi-
   workspace clients would key the cache by workspace id — noted, not built).

**Rationale.** Fingerprint invalidation is the minimal change that closes a real
security/correctness hole (a rotated token must not leave a stale client authenticated
with the old one) without introducing pub/sub or a restart. Explicit-credential clients
are required anyway for Verify (pre-persist), so the factory is not extra surface.

**Alternatives rejected.**
- *TTL-only memo.* A rotated (e.g. compromised) token would keep working until the TTL
  lapsed — unacceptable for the security intent.
- *Cross-process cache-bust via Redis/pub-sub.* Over-engineered for one workspace and a
  small team; the row-fingerprint check gives the same guarantee with a trivial query.
- *Never memoize (build per call).* Throws away rate-limiter/queue state held in the
  client and re-does auth setup every call.

---

## Cross-cutting: contracts (zod) touched, no DDL

- `WorkspaceSettingsSchema` (`packages/contracts/src/jira.types.ts`) gains a typed
  `repositories: {name, git_url, default_branch}[]` (first = default) — a jsonb blob
  extension, **not** a column. `settings` is already `jsonb` (§3).
- New request/response schemas for the dashboard API (workspaces create/verify/rotate,
  agent CRUD, linter error shape) live in `packages/contracts` (single typed source,
  constitution Technology Constraints) and are consumed by both backend and `apps/web`.
- Mini-linter is a pure function in a lib (server authority, FR-012) with a mirror
  published to the client; see `contracts/dashboard-api.md` for the error shape.

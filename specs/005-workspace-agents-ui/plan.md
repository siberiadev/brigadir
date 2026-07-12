# Implementation Plan: Workspace & Agents UI

**Branch**: `005-workspace-agents-ui` | **Date**: 2026-07-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-workspace-agents-ui/spec.md`

## Summary

Ship BRIGADIR's first web dashboard (`apps/web`, Vue 3 + Vite + Element Plus + Pinia +
TanStack Query) with two operator flows — a **verified-before-persist workspace wizard**
and **agent CRUD with a server-authoritative mini-linter** — and flip the source of
truth so the **database, not `agents.yaml`, is authoritative** for orchestration config.
Because real Jira tokens now enter through the UI, Jira credentials become
**AES-256-GCM-encrypted at rest** with user-entered expiry tracking (Principle V
becomes due). No DDL migration is required — every needed column already exists in
architecture §3 (see `data-model.md`). The pipeline (scope, dedup, callbacks) is
untouched; the audit confirms config is already read per-pass from the DB, and the one
real seam — the memoized `LazyJiraClient` going stale on token rotation — is closed with
a fingerprint-checked rebuild (Phase 2).

## Technical Context

**Language/Version**: TypeScript strict (Node ≥22); Vue 3 SFCs for the frontend.

**Primary Dependencies**: Backend — NestJS 11, Drizzle (Postgres 16), BullMQ 5,
`node:crypto` (AES-256-GCM), `@nestjs/serve-static` (new, serves the SPA). Frontend —
Vue 3, Vite, Element Plus, Pinia, `@tanstack/vue-query`, Vue Router. Shared —
`@brigadir/contracts` (zod, single typed source).

**Storage**: Postgres 16 (existing `workspaces`/`executors`/`agents`; **no schema
change**). Credentials in `workspaces.jira_credentials bytea` (format flips to
AES-GCM); repositories in `workspaces.settings` jsonb.

**Testing**: Vitest everywhere. Backend — testcontainers (real Postgres/Redis) + mock
Jira (msw/mock-jira), per-suite `BULLMQ_PREFIX`. Frontend — Vitest + @vue/test-utils +
jsdom + msw component tests for the two critical forms. No E2E this iteration.

**Target Platform**: Self-hosted single node; `docker compose` (postgres, redis,
backend, worker); the backend also serves the built SPA (single image).

**Project Type**: Web application — first frontend (`apps/web`) alongside the Nest
backend/worker apps in the pnpm monorepo.

**Performance Goals**: Operator-facing, not throughput-bound. SC targets: workspace
create <5 min, agent add <2 min. Statuses cached 5-min TTL to bound Jira calls.

**Constraints**: Constitution v1.2.0 (lazy resource resolution; secrets never in argv/
env; credentials encrypted at rest; system-only Jira writes; tests same-iteration for
pipeline logic). Server is the validation authority; client mirrors the linter.

**Scale/Scope**: Small trusted team, single shared bearer, no RBAC. Single workspace
assumption preserved in the runtime Jira-client memo (multi-workspace keying noted, not
built). ~5 dashboard screens (2 functional forms + list/settings; Runs/human-queue are
placeholder routes).

## Constitution Check

*GATE: re-checked after Phase 1 design. Result: **PASS** (initial and post-design).*

| Principle | Assessment |
|-----------|------------|
| I. Dual Source of Truth | Jira stays the status authority; the "DB is authoritative" flip is about **configuration** (workspaces/executors/agents), not ticket status. `last_seen_status` untouched. ✅ |
| II. Idempotency (3 levels) | No trigger path changes. `test-run` reuses `RunTriggerService` → all three layers intact (spec Assumption). yaml import is insert-if-absent (idempotent). ✅ |
| III. System-only Jira writes | UI/backend read Jira (verify, statuses, board) and write **nothing** to Jira; all board writes still flow through the pipeline's `JiraClient`. Wizard Verify is read-only (`/myself`, `getBoard`, statuses). ✅ |
| IV. Run Completion Contract | Not touched — no run/report/callback change. ✅ |
| V. Secret Isolation & at-rest | **This is the iteration that makes at-rest due:** AES-256-GCM codec, env key, fail-fast (FR-020/023), legacy migration (FR-022), expiry badge (FR-021). Credentials never serialized in API responses. Dashboard token + credentials key resolved in DI factories (lazy). ✅ |
| VI. Test-Mandatory Pipeline Logic | Linter, seeder flip, DB-vs-yaml boot, queue provisioning, rotation-invalidation, and credentials codec all get automated tests same-iteration (testcontainers + contract tests). UI gets component tests for the two critical forms (UI may ship lighter coverage, but the forms are the acceptance gate). ✅ |
| Tech constraints (lazy resolution) | New providers (`BRIGADIR_DASHBOARD_TOKEN`, `BRIGADIR_CREDENTIALS_KEY`) use `useFactory`, not `@Module()` args, mirroring `jwt-secret.provider.ts`. `QueuesModule` composition-time read flips from yaml to the `EXECUTOR_TYPES` constant (static structure — documented at call site). ✅ |

**No violations → Complexity Tracking left empty.**

## Project Structure

### Documentation (this feature)
```text
specs/005-workspace-agents-ui/
├── plan.md              # This file
├── research.md          # Phase 0 — R1..R6 decisions
├── data-model.md        # Phase 1 — entities + NO-migration verdict
├── quickstart.md        # Phase 1 — frontend test pattern + validation scenarios
├── contracts/
│   ├── dashboard-api.md      # REST: workspaces, statuses, agents, linter error shape
│   └── credentials-codec.md  # AES-256-GCM envelope + migration + test obligations
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)
```text
apps/web/                         # NEW — Vue 3 + Vite SPA (not a nest-cli project)
├── src/
│   ├── api/                      # typed apiClient (bearer), resource modules
│   ├── stores/                   # Pinia
│   ├── composables/              # TanStack Query hooks (useWorkspaces, useStatuses, useAgents)
│   ├── components/               # WorkspaceWizard/*, AgentForm/*, ExpiryBadge, RepoList
│   ├── views/                    # WorkspaceList, WorkspaceSettings, AgentsList (+ placeholder Runs/HumanQueue)
│   └── router/
├── test/                         # Vitest component tests (msw handlers, mountWithProviders)
├── vite.config.ts                # dev proxy /api → :3000
└── package.json                  # @brigadir/web

apps/backend/src/
├── dashboard/                    # NEW — REST surface
│   ├── dashboard-token.provider.ts / dashboard-token.guard.ts
│   ├── workspaces.controller.ts  # list/verify/create/rotate/settings/statuses
│   └── agents.controller.ts      # CRUD + test-run
└── main.api.ts                   # + serve-static SPA, + legacy-credentials boot migration

libs/jira/src/
├── credentials.codec.ts          # CHANGED — AES-256-GCM envelope + format-sniff decode
├── credentials-key.provider.ts   # NEW — BRIGADIR_CREDENTIALS_KEY (DI factory, fail-fast)
├── jira-client-factory.ts        # NEW — build a client from explicit candidate creds (Verify/rotate)
├── statuses.service.ts           # NEW — getProjectStatuses + 5-min cache (+ force refresh)
├── lazy-jira.client.ts           # CHANGED — fingerprint-checked memo (rotation invalidation)
├── jira.module.ts                # CHANGED — resolver reads a credential fingerprint
├── jira-client.interface.ts      # CHANGED — + getProjectStatuses(projectKey)
└── basic-auth-jira.client.ts     # CHANGED — + getProjectStatuses, + getMyself (Verify identity)

libs/app-config/src/
├── config-seeder.ts              # CHANGED — onConflictDoUpdate → insert-if-absent (DB wins)
└── agents-config.provider.ts     # CHANGED — yaml optional (null when absent)

libs/queues/src/queues.module.ts  # CHANGED — provision run.<type> from EXECUTOR_TYPES, not yaml

packages/contracts/src/
├── jira.types.ts                 # CHANGED — WorkspaceSettings + repositories[]
├── dashboard.schema.ts           # NEW — request/response types for the dashboard API
└── agent-linter.ts               # NEW — pure linter (imported by backend authority + web mirror)
```

**Structure Decision**: Monorepo web-app layout. The frontend is a **new non-Nest**
`apps/web` Vite package under the existing pnpm `apps/*` glob (kept out of
`nest-cli.json`). The backend gains a `dashboard/` module and serves the built SPA
statically (single container). Shared contracts — including the linter used by both
sides — live in `packages/contracts` per the constitution's single-typed-source rule.

## Phases

### Phase 0 — Research ✅ (`research.md`)
R1 frontend scaffolding · R2 credentials codec + migration · R3 statuses source ·
R4 seeder flip + registry queues · R5 dashboard auth · R6 hot-reload audit + rotation
seam. All NEEDS CLARIFICATION resolved; no open unknowns.

### Phase 1 — Design & Contracts ✅
`data-model.md` (entities + explicit **no-migration** verdict), `contracts/` (dashboard
REST + linter error shape, credentials-codec envelope), `quickstart.md` (frontend test
recipe + backend/UI validation scenarios). Agent context refreshed.

### Phase 2 — Implementation outline (for `/speckit-tasks`)
Dependency-ordered, DB-authority + security first, UI last:

1. **Contracts & codec foundation** — `dashboard.schema.ts`, `agent-linter.ts` (+ unit
   tests), `WorkspaceSettings.repositories`; AES-256-GCM `credentials.codec.ts` +
   `credentials-key.provider.ts` (+ contract tests per `credentials-codec.md`).
2. **Source-of-truth flip** — seeder insert-if-absent; yaml optional; `QueuesModule`
   from `EXECUTOR_TYPES`; boot legacy-credentials migration. Integration tests: US3
   matrix (a/b/c/d) + fail-fast key.
3. **Jira read surface** — `getProjectStatuses` + `getMyself` on the client;
   `StatusesService` cache; `JiraClientFactory` for explicit-credential clients.
4. **⚠ Rotation-invalidation seam (flagged)** — `LazyJiraClient` fingerprint-checked
   memo + `jira.module.ts` resolver change; integration test that a rotated token is
   used on the next Jira call and the stale client is not (`quickstart` scenario 6).
   **This is the one place a subtle, security-relevant bug can hide** — a rotated
   (possibly compromised) token must never keep authenticating via the memo, across the
   backend↔worker process boundary. Build + test this before wiring rotation into the UI.
5. **Dashboard API** — `DashboardTokenGuard` + provider; `workspaces.controller`
   (list/verify/create/rotate/settings/statuses) with **server-side re-validation**;
   `agents.controller` (CRUD + linter authority + test-run + soft/hard delete).
   Integration tests: US1 verify/create, US2 linter matrix, US4 rotation/expiry, US5
   at-rest, auth 401.
6. **Frontend `apps/web`** — scaffold (Vite proxy, Element Plus/Pinia/Query, apiClient);
   wizard (steps + Verify); agent form (status selects + client linter mirror);
   workspace list/settings (expiry badge); placeholder Runs/human-queue routes.
   Component tests for the two critical forms.
7. **Serve-static + compose + `.env.example`** — backend serves `apps/web/dist`;
   Dockerfile web build stage; document new env vars.

## Complexity Tracking

*No constitution violations — table intentionally empty.*

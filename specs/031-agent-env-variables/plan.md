# Implementation Plan: Environment variables for agent runs

**Branch**: `031-agent-env-variables` | **Date**: 2026-07-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/031-agent-env-variables/spec.md`

## Summary

Operators configure environment variables at three scopes — workspace defaults, per-repository (primary home), per-agent override — and every repo-mounted run starts with the merged set injected into the spawned agent process, fixed at spawn. Non-secret values live openly in the existing jsonb config blobs (`workspaces.settings.repositories[].env`, `workspaces.settings.env`, `agents.behavior.env`); secret values live in one new sealed bytea per workspace (`workspaces.env_secrets`, same AES-256-GCM envelope as `jira_credentials`), write-only through every API. Injection happens in `ClaudeCliExecutor` as an explicit merge step after the `buildChildEnv` allowlist floor and before `applyAuthEnv`/`applyProviderEnv`, so platform values always win and `ALLOWLIST_KEYS` is never widened. Secret values are additionally registered with a per-run scrubber wrapper so they can never surface in run events, reports, or Jira. UI: workspace settings gains a Repositories card block (per-card edit dialog = repo fields + env table) plus a small workspace-defaults env block; repository rows leave the workspace edit dialog; the agent form gains a collapsed advanced env section. Admin-MCP reaches parity with env on `create_workspace.repositories[]` and a new `set_env` tool that resolves secret values from the operator's environment (never through the model).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (pnpm monorepo)

**Primary Dependencies**: NestJS 11 (backend + worker WorkerHost), Drizzle ORM (Postgres), BullMQ (Redis), zod (contracts package `@brigadir/contracts`), Vue 3 + Element Plus + TanStack Query (dashboard `apps/web`), MCP SDK (`packages/admin-mcp`)

**Storage**: PostgreSQL — existing jsonb blobs (`workspaces.settings`, `agents.behavior`) for non-secret env; one new column `workspaces.env_secrets bytea` (migration `drizzle/0010_env_variables.sql`) sealed with the existing AES-256-GCM envelope (`sealSecret`/`openSecret`, `libs/jira/src/secret-box.ts`, key `BRIGADIR_CREDENTIALS_KEY`)

**Testing**: vitest unit suites per lib/app; integration via testcontainers (real Postgres/Redis, shared containers per run — `test/integration/global-setup.ts`); web component tests (vue-tsc + vitest) in root gates (`pnpm typecheck && pnpm lint && pnpm test`)

**Target Platform**: Self-hosted Linux/macOS (docker compose stack: postgres, redis, backend, worker); trusted-team posture, no sandboxes

**Project Type**: Web service monorepo — NestJS backend (`apps/backend`), worker (`apps/worker`), Vue dashboard (`apps/web`), shared libs (`libs/*`), contracts + admin-MCP packages (`packages/*`)

**Performance Goals**: No new hot paths. Env composition is one extra jsonb read + one `openSecret` per run start (runs are minutes-long; negligible). Settings endpoints stay within existing dashboard latency envelope.

**Constraints**: `ALLOWLIST_KEYS` in `libs/executors/src/claude-cli/env-allowlist.ts` MUST NOT be extended (security floor, Constitution V); user env injected as explicit post-allowlist merge, applied BEFORE `applyAuthEnv`/`applyProviderEnv` so platform auth/provider values are unoverridable; env fixed at spawn (like allowed-tools argv); secret values never in API responses, run_events, reports, logs, or Jira; per-value cap 8 KB, per-run merged cap 64 KB; reserved-key denylist enforced at every write surface and defensively at injection.

**Scale/Scope**: Internal team tool — single-digit workspaces, tens of agents, tens of env vars per workspace. One migration, ~6 contract schema additions, 2 new admin endpoints + 1 new admin-MCP tool, 3 UI surfaces touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Dual Source of Truth | ✅ PASS | Env config lives in Postgres (workspace/agent rows); no new sources of truth, no Jira/Redis state. Run-start snapshot is not persisted as authority — config rows stay the single home. |
| II. Idempotency at Three Levels | ✅ PASS | No new run-triggering paths. Env composition happens inside the existing run lifecycle after dedup layers. |
| III. System-Only Jira Writes | ✅ PASS | Feature writes nothing to Jira. Scrubbing (FR-007) further protects the existing Jira write path from secret leakage. |
| IV. Run Completion Contract | ✅ PASS | Completion protocol untouched. Fail-fast on unopenable `env_secrets` happens before spawn → run fails with diagnostics via the existing exit path, not a silent degradation. |
| V. Secret Isolation & Output Scrubbing | ⚠️ PASS WITH AMENDMENT NOTE | The literal rule "secrets never appear in the agent process environment" governs *platform* secrets (run JWT, vendor API keys, git creds) — those remain out of reach, and the allowlist floor is untouched (explicit test, FR-015). Operator-supplied *service* env is intended for the agent process by definition, is scoped to what the operator explicitly handed over, is sealed at rest with the same envelope, and every secret value is registered with the per-run scrubber before any output path. This is a deliberate narrowing analogous to the feature-015 repo-access narrowing (recorded in constitution §V amendment history at implementation time). Reserved-key denylist prevents operator env from touching platform-managed keys. |
| VI. Test-Mandatory Pipeline Logic | ✅ PASS | Executor lifecycle is on the mandatory-test path: merge/precedence/fixation/reserved-key/scrub tests ship in the same change (FR-015), including the allowlist-floor security test extension (pattern of T085) and integration coverage against real Postgres. |

**Post-Phase-1 re-check**: design artifacts introduce no new violations — data model keeps env inside existing config blobs + one sealed column; contracts keep secrets write-only; no new write paths to Jira; verdicts above unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/031-agent-env-variables/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── env-config.md    # Phase 1 output — schemas, endpoints, MCP tool, injection contract
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── env.schema.ts                  # NEW: EnvVarSchema, key regex, RESERVED_ENV_KEYS, caps, merge types
├── jira.types.ts                  # WorkspaceRepositorySchema: + id?, env? (strict → extended explicitly)
├── agents-config.schema.ts        # AgentBehaviorSchema: + env?
├── dashboard.schema.ts            # WorkspaceSettingsRequestSchema / AgentBehaviorRequestSchema: + env; env-secrets write request; masked read shapes
└── admin-tools.schema.ts          # AdminRepositoryInputSchema: + env; SetEnvInputSchema (new tool)

libs/database/src/
├── schema/workspaces.ts           # + envSecrets: bytea('env_secrets')
└── workspace-settings.ts          # getRepositories(): repo id backfill normalization; getWorkspaceEnv()

libs/executors/src/
├── env-secrets.ts                 # NEW: seal/open codec for the per-workspace env-secrets blob (pattern: executor-secrets.ts)
├── user-env.ts                    # NEW: composeUserEnv (merge precedence, reserved-key filter, caps) + applyUserEnv
└── claude-cli/claude-cli.executor.ts  # loadRunConfig: load+compose user env; runProcess: applyUserEnv between buildChildEnv and applyAuthEnv; per-run scrub wrapper

libs/scrubber/src/scrubber.ts      # + makeScrub(extraLiterals: string[]) wrapper (global scrub unchanged)

apps/backend/src/dashboard/
├── workspaces.controller.ts       # repositories CRUD-ish settings surface + env-secrets write endpoint (masked reads)
└── agents.controller.ts           # behavior.env passthrough + validation

apps/worker/src/                   # (no env composition here — executor owns it; processors unchanged)

packages/admin-mcp/src/
├── tools.ts                       # create_workspace: repositories[].env mapping; NEW set_env tool (secrets from operator env)
└── config.ts                      # optional BRIGADIR_ENV_SECRET_* passthrough convention

apps/web/src/
├── components/WorkspaceForm/WorkspaceForm.vue      # edit mode: drop repo rows (create mode unchanged)
├── components/EnvVarsTable/EnvVarsTable.vue        # NEW: shared key/value/secret editor (validation, masking)
├── views/WorkspaceSettings.vue                     # NEW Repositories card block + workspace env defaults block
├── components/RepositoryCard/ (+ edit FormDialog)  # NEW: card + dialog (repo fields + EnvVarsTable)
└── components/AgentForm/AgentForm.vue              # collapsed advanced env section (override markers)

drizzle/
└── 0010_env_variables.sql         # ALTER TABLE workspaces ADD COLUMN env_secrets bytea

test/integration/                  # env end-to-end: config → run spawn env; secret masking; scrub
libs/executors/src/claude-cli/*.spec.ts  # merge/precedence/reserved/caps/allowlist-floor tests (fake-claude ENV_DUMP harness)
```

**Structure Decision**: Existing monorepo layout; no new packages. The only schema change is one nullable bytea column on `workspaces` — all non-secret env extends existing jsonb blobs, matching how `repositories[]` and `behavior` already work. Env composition lives in `libs/executors` (single place that already resolves mounted repositories), not in worker processors.

## Complexity Tracking

No constitution violations requiring justification. The Principle V narrowing is documented above and in the spec's Assumptions; it is an amendment-note obligation, not a violation (platform secrets remain structurally unreachable; the allowlist floor is untouched and test-guarded).

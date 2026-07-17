# Implementation Plan: Bedrock authentication mode for Claude CLI executor profiles

**Branch**: `018-bedrock-auth-mode` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/018-bedrock-auth-mode/spec.md`

## Summary

Add an `auth` mode to the **existing** `claude_cli` branch of the executor profile contract (`packages/contracts/src/executor.schema.ts`) — `host_subscription` | `api_key` | `bedrock` — kept as **flat optional fields + `superRefine` cross-field rules** (not a nested union) so existing stored jsonb stays valid untouched. Bedrock mode carries `aws_region` (required), `aws_profile` (optional), `ca_bundle_path` (optional). The runtime (`claude-cli.executor.ts`) computes the **effective auth mode** for legacy rows (stored key → `api_key`, else `host_subscription`) and, for bedrock, explicitly injects `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_PROFILE?`, `NODE_EXTRA_CA_CERTS?` into the child env **after** the allowlist pass — the same pattern as the existing `ANTHROPIC_API_KEY` injection; the allowlist itself (`env-allowlist.ts`) is untouched. AWS credentials are never stored/injected — the CLI resolves them from `~/.aws` via the already-allowlisted `HOME`. The Vue `ExecutorForm` gains an auth selector with per-mode fields and a bedrock model-id hint. Tests in the same iteration: contract cases, a pure unit-tested env-injection helper, and integration tests through the fake-claude env-dump harness (T085 lineage). Docs: `docs/local-setup.md` Bedrock section + this feature's `contracts/executor-auth.md`.

## Technical Context

**Language/Version**: TypeScript strict (per constitution), Node 22, NestJS 11 (backend/worker), Vue 3 `<script setup>` (dashboard)

**Primary Dependencies**: zod (shared contracts in `packages/contracts`), Drizzle ORM (Postgres), Element Plus + TanStack Query (form), existing AES-256-GCM secret-box (`executor-secrets.ts` — unchanged), fake-claude test harness (`test/fixtures/claude-cli/fake-claude.mjs` + `test/integration/claude-cli-harness.ts`)

**Storage**: PostgreSQL 16 — `executors.config` jsonb gains additive camelCase keys (`auth`, `awsRegion`, `awsProfile`, `caBundlePath`); **no migration, no schema change** (`docs/architecture.md` §3 tables untouched); `executors.secrets` bytea semantics unchanged

**Testing**: vitest unit specs colocated in `libs/executors/src/claude-cli/` and `packages/contracts/src/`; integration via vitest + testcontainers (`test/integration/claude-cli-*.spec.ts`, shared containers per run); web via vitest + jsdom + MSW (`apps/web/test/executor-form.spec.ts`)

**Target Platform**: Self-hosted worker on a team member's machine (Linux/macOS); spawned `claude` CLI reaching AWS Bedrock through corporate network (optional TLS-intercepting proxy → CA bundle)

**Project Type**: pnpm monorepo web application (`apps/backend`, `apps/worker`, `apps/web`, `packages/contracts`, `libs/executors`)

**Performance Goals**: N/A — config-plumbing feature; zero hot-path changes (one branch in child-env construction per spawn)

**Constraints**: Constitution V (secret isolation: allowlist floor unchanged, no credentials in argv/env/DB); backward compatibility — legacy rows behave byte-identically (SC-002); single source of truth — the shared zod union drives both backend validation and the form field set (feature 005 pattern)

**Scale/Scope**: ~2 contract files, ~4 executor-lib files, 1 controller, 1 Vue form + 1 web spec, ~4 integration specs (2 new, 2 extended), 2 docs. No new packages, no new dependencies.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Status | Notes |
|---|---|---|---|
| I. Dual Source of Truth | No | ✅ PASS | No ticket/run state involved; profile config stays in Postgres (its existing home). |
| II. Idempotency at Three Levels | No | ✅ PASS | No run-triggering path touched; env construction happens inside an already-triggered run. |
| III. System-Only Jira Writes | No | ✅ PASS | No Jira interaction. |
| IV. Run Completion Contract | No | ✅ PASS | Completion channels untouched; a bedrock auth failure surfaces through the existing crashed/failed path (spec FR-012) — no new fallback. |
| V. Secret Isolation & Output Scrubbing | **Yes — core** | ✅ PASS | Allowlist floor unchanged by design (FR-005); bedrock values are non-secret config injected from the DB profile, never host shell; AWS credentials stay in `~/.aws`, reachable only via allowlisted `HOME` (same posture as `~/.claude`); `api_key` stays write-only/sealed. Mandatory security test extended (T085 lineage: canary `AWS_*`/`ANTHROPIC_*` in worker env must not reach the child in ANY mode). |
| VI. Test-Mandatory Pipeline Logic | Yes | ✅ PASS | Executor lifecycle/env construction is pipeline logic → unit tests for the pure auth-env helper + effective-auth defaulting, contract tests for the schema branch, integration tests through the real spawn path (fake claude env dump) — all in the same iteration (FR-013). |
| Technology Constraints | Yes | ✅ PASS | No new deps; strict TS; contracts extended in `packages/contracts`; no `@Module()` composition-time reads introduced; jsonb additive only — §3 schema untouched, so no architecture-doc schema amendment needed (config-comment touch-up only). |

**Initial gate: PASS** (no violations; Complexity Tracking empty).
**Post-design re-check: PASS** — design adds no projects/dependencies; wire change is additive+refined on an existing branch; storage change is additive jsonb keys; the one deliberate behavior delta for legacy rows (secrets decrypted only when the effective mode is `api_key`) is byte-identical for every legacy row by the defaulting rule (see research.md D4).

## Project Structure

### Documentation (this feature)

```text
specs/018-bedrock-auth-mode/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── executor-auth.md # Wire/storage/child-env contract for the auth modes
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── executor.schema.ts            # MODIFY: claude_cli branch gains auth/aws_region/aws_profile/
│                                 #         ca_bundle_path (flat, optional) + superRefine per-mode rules;
│                                 #         header comment documents the defaulting rule
├── executor.schema.spec.ts       # MODIFY: contract cases per mode (region required, foreign-field
│                                 #         rejection, legacy shape still valid, api_key×auth matrix)
└── agents-config.schema.ts       # MODIFY: ClaudeCliExecutorConfigSchema (yaml/boot branch) gains the
                                  #         same optional camelCase fields (auth, awsRegion, awsProfile,
                                  #         caBundlePath) so both config entrances stay aligned

libs/executors/src/
├── claude-cli/claude-cli.config.ts    # MODIFY: ClaudeCliRuntimeConfig + resolveClaudeCliConfig carry
│                                      #         the resolved auth block; NEW pure helpers:
│                                      #         resolveEffectiveAuth(config, hasStoredKey) and
│                                      #         applyAuthEnv(env, auth, apiKey) (injection after allowlist)
├── claude-cli/claude-cli.config.spec.ts  # MODIFY: unit tests — defaulting matrix + exact injected
│                                         #         keys/values per mode (FR-013 unit half)
├── claude-cli/claude-cli.executor.ts  # MODIFY: loadRunConfig computes effective auth; decrypts secrets
│                                      #         ONLY for effective api_key mode; runProcess replaces the
│                                      #         inline `if (apiKey)` with applyAuthEnv(...)
├── claude-cli/env-allowlist.ts        # NO CHANGE — the floor (FR-005); doc comment gains one line
└── executor-secrets.ts                # NO CHANGE — sealed-blob codec untouched (FR-009 keeps blobs inert)

apps/backend/src/dashboard/
└── executors.controller.ts       # MODIFY: toInsertValues/toExecutorResponse map the new fields
                                  #         (snake_case wire ↔ camelCase jsonb); response exposes the
                                  #         EFFECTIVE auth; update-path guard: auth=api_key with no
                                  #         stored and no provided key → 422 (FR-007)

apps/web/src/components/ExecutorForm/
└── ExecutorForm.vue              # MODIFY: auth selector (default = effective auth from response);
                                  #         api_key block only for auth=api_key; bedrock fields only for
                                  #         auth=bedrock; model hint for bedrock (full Bedrock model id)

apps/web/test/
└── executor-form.spec.ts         # MODIFY: mode switching, conditional fields, hint, request bodies

test/integration/
├── claude-cli-bedrock.spec.ts    # NEW: fake-claude env dump for a bedrock profile — exact injected
│                                 #      env asserted, polluted host AWS_*/ANTHROPIC_* absent (FR-013)
├── claude-cli-security.spec.ts   # MODIFY: T085 canary matrix extended (AWS_REGION/AWS_PROFILE/
│                                 #         CLAUDE_CODE_USE_BEDROCK/NODE_EXTRA_CA_CERTS canaries; all
│                                 #         three modes keep the floor)
├── claude-cli-profile.spec.ts    # MODIFY: inert-key case — bedrock profile WITH sealed key →
│                                 #         no ANTHROPIC_API_KEY in child env (FR-009)
└── executor-crud.spec.ts         # MODIFY: API round-trip of new fields; effective-auth in responses;
                                  #         422 matrix (missing region; keyless api_key mode; foreign field)

docs/
├── local-setup.md                # MODIFY: new section «Bedrock / корпоративный Claude» (prereqs:
│                                 #         ~/.aws profile, CA bundle, model-id guidance, SSO refresh)
└── architecture.md               # MODIFY: executors config commentary — one paragraph on auth modes
                                  #         + defaulting rule (no §3 DDL change)
```

**Structure Decision**: Existing monorepo layout as-is; the feature is confined to the contract package, the claude-cli executor lib, one controller, one Vue form, tests, and docs. One new file of production-adjacent code total (the integration spec); everything else modifies files in place.

## Complexity Tracking

No constitution violations — table intentionally empty.

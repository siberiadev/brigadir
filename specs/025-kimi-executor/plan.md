# Implementation Plan: First-class kimi executor type (Moonshot AI backend)

**Branch**: `claude/new-session-twp7q4` (spec dir `025-kimi-executor`) | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/025-kimi-executor/spec.md`

## Summary

Add a first-class executor type `kimi` that runs pipeline agents on Moonshot AI's Kimi models by reusing the existing Claude CLI harness (`libs/executors/src/claude-cli/`) against Moonshot's Anthropic-compatible endpoint (`https://api.moonshot.ai/anthropic`). Implementation: parameterize `ClaudeCliExecutor` with a constructor-level **provider preset** `{ type, anthropicBaseUrl? }` and register two DI instances under the `AGENT_EXECUTORS` token (`claude_cli` — no base URL, byte-identical behavior; `kimi` — Moonshot URL). Kimi profiles are api_key-only (key required on create/update-to-keyless rejected), runs get immutable `runs.executor_type = 'kimi'` and travel through a new `run.kimi` BullMQ queue with the standard per-profile gate. Endpoint + decrypted key are injected strictly **after** the `buildChildEnv` allowlist pass, from the in-code constant and the profile row only; `ANTHROPIC_BASE_URL` stays permanently off the allowlist. No DB migration (feature-018 precedent). `cost_usd` on kimi runs is marked indicative in the UI + docs. No seeded kimi profile (clarified 2026-07-19).

## Technical Context

**Language/Version**: TypeScript strict (Node 20+), pnpm workspace monorepo

**Primary Dependencies**: NestJS 11 (backend `apps/backend`, worker `apps/worker` WorkerHost), BullMQ 5 (queues), Drizzle ORM (Postgres 16), zod (contracts in `packages/contracts`), Vue 3 + Element Plus (`apps/web`)

**Storage**: Postgres 16 — `executors` (type text, config jsonb camelCase, secrets bytea AES-256-GCM), `runs.executor_type` denormalized text. **No DDL for this feature.**

**Testing**: vitest units (`pnpm test`), vitest + testcontainers integration (`pnpm test:integration`, shared PG/Redis containers per run via `test/integration/global-setup.ts`, per-suite `BULLMQ_PREFIX`), fake-claude fixtures `test/fixtures/claude-cli/*.ndjson`

**Target Platform**: Linux server (docker compose: postgres, redis, backend, worker) + self-hosted worker machines

**Project Type**: web service (backend + worker + SPA dashboard), monorepo apps/libs/packages

**Performance Goals**: N/A beyond existing pipeline norms — kimi adds one queue and one more registered executor instance; no new hot paths

**Constraints**: env-allowlist floor immutable (`env-allowlist.ts` header: "the floor; do not extend it for auth modes"); `claude_cli` snapshots/spec must not change; composition-time reads only for static structure (queue names, endpoint constant); secrets only via `sealExecutorSecrets`/`openExecutorSecrets`

**Scale/Scope**: internal team tool; ~9 source touch points + tests + docs; one iteration (0.5–2 days, one PR)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Evidence |
|---|---|---|
| I. Dual Source of Truth | ✅ Pass | No new state sources. Run state stays in Postgres; kimi queue is transient BullMQ only. |
| II. Idempotency at Three Levels | ✅ Pass | Kimi runs enter through the existing enqueue path: webhook dedup and `runs_one_active` are type-agnostic; BullMQ `deduplication: {id: ticket:agent}` applies on the new queue identically. No layer touched. |
| III. System-Only Jira Writes | ✅ Pass | Shared harness/wrapper unchanged; agents report via callback tools; Jira writes stay behind the per-issue write queue. |
| IV. Run Completion Contract | ✅ Pass | Shared `ClaudeCliRunProcessor` logic (near-copy/shared base) keeps the single completion channel, Stop-hook enforcement, and all `WHERE status='running'` finalization guards (CLAUDE.md rule 7) byte-identical. |
| V. Secret Isolation & Output Scrubbing | ✅ Pass | Moonshot key sealed with `sealExecutorSecrets` (AES-256-GCM), decrypted only at spawn, injected after `buildChildEnv`, never in argv; `ANTHROPIC_BASE_URL` off allowlist by design; scrubber path unchanged. |
| VI. Test-Mandatory Pipeline Logic | ✅ Pass | Unit + integration tests planned in the same iteration (see quickstart.md / spec FR-017); `claude-cli-bedrock.spec.ts` is the direct integration precedent to mirror. |
| Tech: Lazy resource resolution | ✅ Pass | The Moonshot endpoint constant and `runQueueName('kimi')` in the `@Processor` decorator are static structure (documented at call site, same as existing processors). Credentials resolved per-run inside the executor, never at composition time. |

**Post-design re-check (after Phase 1)**: ✅ unchanged — design artifacts introduce no new violations; Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/025-kimi-executor/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── kimi-executor-api.md      # Dashboard API contract (snake_case)
│   └── kimi-provider-env.md      # Provider preset & child-env injection contract
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
libs/executors/src/
├── agent-executor.interface.ts     # +'kimi' in EXECUTOR_TYPES (lines 7–13)
├── executors.module.ts             # 2nd ClaudeCliExecutor instance in AGENT_EXECUTORS factory (lines 20–26)
├── executor.registry.ts            # no changes (resolves by executor.type)
├── executor-secrets.ts             # no changes (reused for kimi key)
└── claude-cli/
    ├── claude-cli.executor.ts      # constructor provider preset {type, anthropicBaseUrl?}; readonly type from preset (line 164)
    ├── claude-cli.config.ts        # provider-env injection next to applyAuthEnv (lines 118–136); kimi = api_key-only auth resolution
    └── env-allowlist.ts            # NO CHANGES — floor stays as-is (verify only)

packages/contracts/src/
├── agents-config.schema.ts         # +'kimi' EXECUTOR_TYPES (16–22) & RUN_QUEUE_EXECUTOR_TYPES (32);
│                                   # KimiExecutorConfigSchema branch in union (127–133); superRefine coverage (210, 253)
└── executor.schema.ts              # +'kimi' ExecutorTypeSchema (44); KimiExecutorApiConfigSchema (strict, snake_case);
                                    # create union + key-required-on-create refinement; update union

libs/queues/src/
└── queues.module.ts                # no changes — queues derive from RUN_QUEUE_EXECUTOR_TYPES

apps/worker/src/
├── kimi-run.processor.ts           # NEW — @Processor(runQueueName('kimi')), shares ClaudeCliRunProcessor logic
├── claude-cli-run.processor.ts     # extract shared base (or near-copy source) — behavior unchanged
└── app.module.ts                   # register KimiRunProcessor (providers, line 44)

apps/backend/src/dashboard/
├── executors.controller.ts         # snake↔camel mappers + update-side key rule cover type 'kimi' (lines 100, 193, 226)
└── executor-seed.ts                # NO kimi seeding (clarified) — no changes expected

apps/web/src/
├── components/ExecutorForm/ExecutorForm.vue   # +kimi el-option (152–157); kimi field block (no URL, no auth selector)
├── views/RunCard.vue               # indicative-cost marker for executor_type==='kimi' (line 197)
└── views/Runs.vue                  # indicative-cost marker in cost column (line 193)

test/
├── integration/kimi-*.spec.ts      # NEW — mirrors claude-cli-bedrock.spec.ts / claude-cli-security.spec.ts
└── fixtures/claude-cli/            # reused as-is (stream format unchanged)

docs/
├── architecture.md                 # §4: kimi column/row in Реализации table (385–392), interface union (375), cost caveat
└── progress.md                     # iteration entry
```

**Structure Decision**: Existing monorepo layout; no new packages or apps. The only new files are `apps/worker/src/kimi-run.processor.ts`, its tests, and integration suites — everything else is edits at the exact points listed above (verified by recon 2026-07-19).

## Complexity Tracking

No constitution violations — table intentionally empty.

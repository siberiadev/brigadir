# Implementation Plan: First-class deepseek_api executor type (DeepSeek backend)

**Branch**: `claude/deepseek-api-executor-e4ded2` (spec dir `028-deepseek-executor`) | **Date**: 2026-07-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/028-deepseek-executor/spec.md`

## Summary

Add the third provider preset over the shared Claude CLI harness: executor type `deepseek_api`, pointing the harness at DeepSeek's official Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`). This is a structural repeat of feature 025 (kimi/Moonshot) — the machinery (provider preset, DI factory instance, dedicated `run.<type>` queue, thin processor subclass, strict api_key-only contracts, write-only sealed key) already exists and is extended, not rebuilt. Two consolidations ship with it (spec FR-016): the "CLI-harness types" set (currently two hardcoded `!== 'claude_cli' && !== 'kimi'` conditionals in `agents-config.schema.ts`) and the "api-key-only preset types" set (currently `if (this.preset.type === 'kimi')` in the executor) each become one shared constant, so a fourth provider never touches parallel conditionals again. Definition of done includes a real-API smoke run (spec FR-017) whose primary hypothesis is that the callback channel (client-side stdio MCP) works against DeepSeek; its failure is a stop condition.

## Technical Context

**Language/Version**: TypeScript strict (Node 20+), pnpm workspace monorepo

**Primary Dependencies**: NestJS 11 (backend `apps/backend`, worker `apps/worker` WorkerHost), BullMQ 5 (queues), Drizzle ORM (Postgres 16), zod (contracts in `packages/contracts`), Vue 3 + Element Plus (`apps/web`)

**Storage**: Postgres 16 — `executors` (type text, config jsonb camelCase, secrets bytea AES-256-GCM), `runs.executor_type` denormalized text. **No DDL for this feature** (feature-018/025 precedent).

**Testing**: vitest units (`pnpm test`), vitest + testcontainers integration (`pnpm test:integration`, shared PG/Redis containers via `test/integration/global-setup.ts`, per-suite `BULLMQ_PREFIX`), fake-claude fixtures `test/fixtures/claude-cli/*.ndjson` (reused as-is — binary and stream format unchanged)

**Target Platform**: Linux server (docker compose: postgres, redis, backend, worker) + self-hosted worker machines

**Project Type**: web service (backend + worker + SPA dashboard), monorepo apps/libs/packages

**Performance Goals**: N/A beyond existing pipeline norms — one more queue and one more registered executor instance; no new hot paths

**Constraints**: env-allowlist floor immutable (`ANTHROPIC_BASE_URL` stays off it permanently); `claude_cli` AND `kimi` behavior byte-identical (their suites/snapshots must pass unmodified); composition-time reads only for static structure (queue names, endpoint constant); secrets only via `sealExecutorSecrets`/`openExecutorSecrets`; the smoke-test API key exists only in the create-request body and the sealed blob — never in code/tests/logs/.env/specs

**Scale/Scope**: internal team tool; ~13 source touch points (see structure below) + tests + docs; one iteration, one PR

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Evidence |
|---|---|---|
| I. Dual Source of Truth | ✅ Pass | No new state sources. Run state stays in Postgres; `run.deepseek_api` queue is transient BullMQ only. |
| II. Idempotency at Three Levels | ✅ Pass | Deepseek runs enter through the existing enqueue path: webhook dedup and `runs_one_active` are type-agnostic; BullMQ `deduplication: {id}` applies on the new queue identically. `maxStalledCount: 0` carried over (CLAUDE.md rule 2). |
| III. System-Only Jira Writes | ✅ Pass | Shared harness/wrapper unchanged; agents report via callback tools; Jira writes stay behind the per-issue write queue. |
| IV. Run Completion Contract | ✅ Pass | `DeepseekRunProcessor extends ClaudeCliRunProcessor` inherits the single completion channel, Stop-hook enforcement, and all `WHERE status='running'` finalization guards verbatim (CLAUDE.md rule 7) — the same one-line-subclass shape as `KimiRunProcessor`. |
| V. Secret Isolation & Output Scrubbing | ✅ Pass | DeepSeek key sealed with `sealExecutorSecrets` (AES-256-GCM), decrypted only at spawn, injected after `buildChildEnv`, never in argv; `ANTHROPIC_BASE_URL` off allowlist by design; scrubber path unchanged; smoke test explicitly re-verifies no key in timeline/diagnostics (spec SC-006). |
| VI. Test-Mandatory Pipeline Logic | ✅ Pass | Unit + integration tests in the same iteration (spec FR-019); the four kimi integration suites are the direct template to mirror. |
| Tech: Lazy resource resolution | ✅ Pass | `DEEPSEEK_ANTHROPIC_BASE_URL` and `runQueueName('deepseek_api')` in the `@Processor` decorator are static structure (documented at call site, same carve-out as the kimi constant and processors). Credentials resolved per-run inside the executor, never at composition time. |

**Post-design re-check (after Phase 1)**: ✅ unchanged — design artifacts introduce no new violations; Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/028-deepseek-executor/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── deepseek-executor-api.md      # Dashboard API contract (snake_case)
│   └── deepseek-provider-env.md      # Provider preset & child-env injection contract
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

All line numbers verified against the working tree on 2026-07-22.

```text
packages/contracts/src/
├── executor.schema.ts              # +'deepseek_api' in ExecutorTypeSchema (48);
│                                   # DeepseekExecutorApiConfigSchema — clone of Kimi branch (147–161);
│                                   # all three unions: ExecutorApiConfigSchema (167–171),
│                                   # ExecutorCreateRequestSchema w/ key-required refinement (184–209),
│                                   # ExecutorUpdateRequestSchema (216–221);
│                                   # NEW shared constants API_KEY_ONLY_EXECUTOR_TYPES +
│                                   # CLI_HARNESS_API_EXECUTOR_TYPES (+ type guards) — FR-016
└── agents-config.schema.ts         # +'deepseek_api' in RUN_QUEUE_EXECUTOR_TYPES (33) — this IS the queue provisioning;
                                    # DeepseekExecutorConfigSchema branch — clone of KimiExecutorConfigSchema (129–147);
                                    # replaces passthroughExecutorConfig('deepseek_api') in the union (169);
                                    # both superRefine conditionals (248, 291) switch to shared
                                    # CLI_HARNESS_EXECUTOR_TYPES constant — FR-016
                                    # ('deepseek_api' already in EXECUTOR_TYPES (22) — no change)

libs/executors/src/
├── agent-executor.interface.ts     # NO CHANGES — 'deepseek_api' already in EXECUTOR_TYPES (verify only)
├── executors.module.ts             # DEEPSEEK_EXECUTOR = Symbol(...) + useFactory building
│                                   # ClaudeCliExecutor with {type:'deepseek_api', anthropicBaseUrl: DEEPSEEK_...};
│                                   # added to AGENT_EXECUTORS factory (48–55). Registry-only, no class token (same as KIMI_EXECUTOR, 19)
├── executor.registry.ts            # no changes (resolves by executor.type)
├── executor-secrets.ts             # no changes (reused for the DeepSeek key)
└── claude-cli/
    ├── claude-cli.config.ts        # DEEPSEEK_ANTHROPIC_BASE_URL constant beside MOONSHOT_... (17), doc comment twinned;
    │                               # API-key-only preset membership sourced from the shared contracts constant — FR-016;
    │                               # applyProviderEnv (171) unchanged — already preset-generic
    ├── claude-cli.executor.ts      # keyless-guard at 776: `if (this.preset.type === 'kimi')` generalizes to the
    │                               # shared api-key-only set (one membership check, NOT a second if); per-type error message
    └── env-allowlist.ts            # NO CHANGES — floor stays as-is (verify only)

libs/queues/src/
├── queues.module.ts                # no changes — queues derive from RUN_QUEUE_EXECUTOR_TYPES
└── queues.module.spec.ts           # assert run.deepseek_api in the provisioned set (11–17)

apps/worker/src/
├── deepseek-run.processor.ts       # NEW — clone of kimi-run.processor.ts: @Processor(runQueueName('deepseek_api'),
│                                   # {concurrency: 2, maxStalledCount: 0, settings: {backoffStrategy}, autorun: false}),
│                                   # extends ClaudeCliRunProcessor, executorType = 'deepseek_api'
├── app.module.ts                   # register DeepseekRunProcessor (import 15, providers ~54)
├── worker-lock.bootstrap.ts        # NOT in the feature brief but REQUIRED (feature 027): inject the new processor
│                                   # (constructor, 35) and include its worker in workers() (44) — otherwise
│                                   # run.deepseek_api is never consumed (autorun:false gated by the lock)
├── executor-concurrency.ts         # no changes — type-agnostic
└── executor-gate.ts                # no changes — type-agnostic (EXECUTOR_MODEL_LIMITS keys on config.model string)

apps/backend/src/dashboard/
└── executors.controller.ts         # update-side "key provided OR stored, else 422" covers deepseek_api (103, 117);
                                    # apiKey extraction (131), insert-values mapping (215), sealApiKey guard (237),
                                    # response mapping w/o auth field (268) — all via the shared contracts
                                    # constants/type-guards instead of adding a third literal each time — FR-016

apps/web/src/
├── components/ExecutorForm/ExecutorForm.vue
│                                   # +deepseek_api el-option (193); isCliHarness (60) + showApiKey (64) via shared
│                                   # constants; config-build branch (102–108); create-time key-required check (158–161);
│                                   # no-Clear-button rule (249) and placeholder (264) extended;
│                                   # NEW model hint (206 area): native ids deepseek-v4-pro / deepseek-v4-flash,
│                                   # indicative-cost caveat, silent-substitution warning
├── views/settings/SettingsExecutors.vue   # deepseek_api joins the first-class (non-muted) type styling (68)
├── views/RunCard.vue               # indicative-cost marker covers deepseek_api (116); provider-aware tooltip (119)
└── views/Runs.vue                  # same marker in the cost column (250–251)

test/
├── integration/deepseek-run.spec.ts        # NEW — mirrors kimi-run.spec.ts (env injection, success/rate-limit/crash)
├── integration/deepseek-gate.spec.ts       # NEW — mirrors kimi-gate.spec.ts (per-profile gate, live re-apply)
├── integration/deepseek-security.spec.ts   # NEW — mirrors kimi-security.spec.ts (polluted shell, key scrubbing)
├── integration/deepseek-executor-crud.spec.ts  # NEW — mirrors kimi-executor-crud.spec.ts (422 matrix, has_api_key)
└── fixtures/claude-cli/            # reused as-is (stream format unchanged)

docs/
├── architecture.md                 # §4: deepseek_api row in the executor table (transport: Claude CLI harness
│                                   # against DeepSeek's Anthropic-compatible endpoint; cost caveat; smoke findings)
└── progress.md                     # iteration entry (appended at the end of /speckit-implement)
```

**Structure Decision**: Existing monorepo layout; no new packages or apps. New files: `apps/worker/src/deepseek-run.processor.ts` and the four integration suites — everything else is edits at the exact points listed above (verified by recon 2026-07-22). Contracts dist must be rebuilt after schema edits (`pnpm --filter @brigadir/contracts build`) or the web app resolves the stale gitignored `dist`.

## Complexity Tracking

No constitution violations — table intentionally empty.

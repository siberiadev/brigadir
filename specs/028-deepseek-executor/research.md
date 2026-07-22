# Research: deepseek_api executor type (028)

**Date**: 2026-07-22. No `NEEDS CLARIFICATION` markers existed in the Technical Context. Most decisions are inherited from feature 025 (kimi) — validated against the post-025 codebase by recon on 2026-07-22 — plus the deepseek-specific facts and the FR-016 consolidation shape. Line numbers below are current working-tree positions.

## D1. Third provider preset, not a direct-API executor

- **Decision**: `deepseek_api` = the existing `ClaudeCliExecutor` parameterized with a provider preset `{ type: 'deepseek_api', anthropicBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL }`. Not a new executor implementation.
- **Rationale**: DeepSeek ships an official Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`, env-configured via `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`, tool use and streaming supported). The whole preset mechanism (feature 025, `ProviderPreset` in claude-cli.config.ts:25–28, applied by `applyProviderEnv` at :171) was designed for exactly this: 025's spec listed "DeepSeek or other Anthropic-compatible providers" as the anticipated next user. A direct-API executor (against DeepSeek's native OpenAI-style API) would need a new agent loop, stream parser, tool bridge and report enforcement — all machinery the harness already has.
- **Alternatives considered**: direct-API executor — rejected (out of scope per spec; enormously more surface); a provider field in claude_cli config — rejected in 025 (mutable attribution) and the same reasoning binds here.
- **Note on the reserved name**: `'deepseek_api'` already sits in both `EXECUTOR_TYPES` lists (contracts agents-config.schema.ts:22 and libs agent-executor.interface.ts) as a declared-but-unimplemented slot. The name is kept even though the transport is the CLI harness, not a direct API — 025's naming logic ("type = provider identity, not harness identity") makes the `_api` suffix harmless: it identifies the provider account/key, and the transport can change later without renaming the type.

## D2. Registration: symbol-token factory instance, registry-only

- **Decision**: `executors.module.ts` gains `DEEPSEEK_EXECUTOR = Symbol('DEEPSEEK_EXECUTOR')` + `useFactory` building `new ClaudeCliExecutor(db, agentsConfig, jira, { type: 'deepseek_api', anthropicBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL })` with `inject: [DRIZZLE, AGENTS_CONFIG, JIRA_CLIENT]`, appended to the `AGENT_EXECUTORS` factory array (48–55). No subclass; not resolvable by class token (that stays the claude_cli instance).
- **Rationale**: Byte-for-byte the `KIMI_EXECUTOR` pattern (19, 38–46). `ExecutorRegistry` resolves by `executor.type` from the injected array — zero registry changes.

## D3. Endpoint constant + env injection: no new code path

- **Decision**: `DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'` beside `MOONSHOT_ANTHROPIC_BASE_URL` (claude-cli.config.ts:17) with a twinned doc comment (Constitution lazy-resolution carve-out: static structure — the identity of the type, not a credential). `applyProviderEnv` (:171) needs **no changes** — it is already preset-generic (sets `ANTHROPIC_BASE_URL` iff the preset carries one). Call order in `runProcess` (executor.ts:402–412) unchanged: `buildChildEnv` → `applyAuthEnv` → `applyProviderEnv` → `spawnGroup`.
- **Rationale**: The kimi contract (`specs/025-kimi-executor/contracts/kimi-provider-env.md`) governs the mechanism; 028 adds one row to its preset table. `ANTHROPIC_BASE_URL` stays permanently off `ALLOWLIST_KEYS` — the polluted-shell invariants re-assert for the new type.

## D4. FR-016 consolidation: two shared type-set constants

- **Decision**: Two new exported constants in `packages/contracts` (single source for schema, controller, and web form):
  - `executor.schema.ts`: `API_KEY_ONLY_EXECUTOR_TYPES = ['kimi', 'deepseek_api'] as const` (+ guard `isApiKeyOnlyExecutorType(t)`) and `CLI_HARNESS_API_EXECUTOR_TYPES = ['claude_cli', 'kimi', 'deepseek_api'] as const` (+ guard `isCliHarnessApiExecutorType(t)`).
  - `agents-config.schema.ts`: `CLI_HARNESS_EXECUTOR_TYPES = ['claude_cli', 'kimi', 'deepseek_api'] as const` for the camelCase config layer; both `superRefine` conditionals (248: deprecated `repository` cross-check; 291: `allowedTools` fallback rule) switch from `type !== 'claude_cli' && type !== 'kimi'` to membership in this set.
  - `libs/executors/claude-cli.executor.ts:776`: the keyless fail-loud guard becomes a membership check against `API_KEY_ONLY_EXECUTOR_TYPES` (imported from contracts — `ExecutorType` in libs is a superset of the API enum, so the check is a plain string-set lookup), NOT a second `if`. Error message parameterized per type ("re-enter the DeepSeek key…" / "…Moonshot key…").
  - `apps/backend/executors.controller.ts` (103/117/131/215/237/268) and `apps/web/ExecutorForm.vue` (60/64/102/158/249/264) consume the same guards instead of adding a third literal to each conditional.
- **Rationale**: Spec FR-016 — a fourth preset must extend one definition. Contracts is the only package all three consumers (libs, backend, web) already import. The config-layer and API-layer lists stay separate constants because the layers deliberately keep separate type vocabularies (025 research: "do not attempt to unify them").
- **Alternatives considered**: a single constant in libs/executors — rejected (web cannot import server libs); deriving membership from the presence of `anthropicBaseUrl` in the preset — rejected (conflates "has fixed endpoint" with "api-key-only"; claude_cli-with-bedrock breaks the equivalence and the contracts layer has no preset visibility).

## D5. Contracts: strict deepseek branches, clone-of-kimi

- **Decision**:
  - `executor.schema.ts`: `DeepseekExecutorApiConfigSchema` — literal clone of `KimiExecutorApiConfigSchema` (147–161) with `type: z.literal('deepseek_api')`: model, cli_path, use_callback_channel, keep_failed_worktrees, max_turns, max_parallel_runs, write-only `api_key` (`.strict()` rejects auth/AWS/base-URL fields). Added to `ExecutorApiConfigSchema` (167–171), `ExecutorCreateRequestSchema` with the create-only "deepseek_api requires an api_key on create" refinement (mirror of 200–208), and `ExecutorUpdateRequestSchema` (216–221). `ExecutorTypeSchema` (48) gains the member.
  - `agents-config.schema.ts`: `DeepseekExecutorConfigSchema` — clone of `KimiExecutorConfigSchema` (129–147) with the deepseek literal; **replaces** `passthroughExecutorConfig('deepseek_api')` in `ExecutorConfigSchema` (169) — the type graduates from passthrough to typed+strict exactly as claude_cli and kimi did. `RUN_QUEUE_EXECUTOR_TYPES` (33) gains `'deepseek_api'` — that one edit IS the queue provisioning (QueuesModule maps the list through `runQueueName` into `BullModule.registerQueue`).
  - Rebuild `packages/contracts` dist after edits — the web app's bare import resolves into the gitignored `dist` (memory: merged-≠-deployed trap).
- **Rationale**: Same two-layer shape as 025 D5. The passthrough→strict graduation is a behavior change for hypothetical stored `deepseek_api` rows with junk fields — none can exist (the type was never runnable), so it is safe.

## D6. Worker processor: one-line subclass on `run.deepseek_api` + worker-lock registration

- **Decision**: New `apps/worker/src/deepseek-run.processor.ts` — clone of `kimi-run.processor.ts`: `@Processor(runQueueName('deepseek_api'), { concurrency: 2, maxStalledCount: 0, settings: { backoffStrategy }, autorun: false })`, `class DeepseekRunProcessor extends ClaudeCliRunProcessor { protected override readonly executorType = 'deepseek_api' }`. Registered in `WorkerAppModule` providers AND — critical, not in the feature brief — injected into `WorkerLockBootstrap` (worker-lock.bootstrap.ts:31–48) and included in its `workers()` array.
- **Rationale**: Since feature 027, ALL queue consumption is gated by the exclusive worker lock: processors declare `autorun: false` and only start when `WorkerLockBootstrap.resumeAll()` runs them. A processor registered in the module but missing from `workers()` never consumes — `run.deepseek_api` jobs would sit queued forever. This is the one structural difference from the 025 plan (which predates 027). `executor-gate.ts` / `executor-concurrency.ts` are type-agnostic — untouched; `EXECUTOR_MODEL_LIMITS` caps key on the `config.model` string and apply to native DeepSeek ids as-is.

## D7. Backend dashboard: extend via shared guards, no seeding

- **Decision**: `executors.controller.ts` — the update-side key rule (103: `(claude_cli && auth==='api_key') || type==='kimi'` → api-key-only membership; 117: per-type 422 message), `apiKey` extraction (131), insert-values mapping (215), `sealApiKey` guard (237), and response mapping (268, no `auth` computed for key-only types) all extend to `deepseek_api` through the D4 guards. No seeding (inherited 025 decision) — `executor-seed.ts` untouched.
- **Rationale**: Key handling (sealApiKey → `sealExecutorSecrets`) is type-agnostic and reused as-is.

## D8. Web UI: selector, model hint with the silent-substitution warning, indicative cost

- **Decision**: `ExecutorForm.vue`: add `deepseek_api` el-option (193); `isCliHarness` (60) and `showApiKey` (64) switch to the shared guards (deepseek_api shows the key block unconditionally, like kimi); config-build branch (102–108), create-time key-required pre-check (158–161), no-Clear-button rule (249), `sk-...` placeholder (264) all cover the new type. New model hint (206 pattern, `data-test="deepseek-model-hint"`): native ids `deepseek-v4-pro` / `deepseek-v4-flash`; cost figures indicative (Anthropic price list); **unrecognized model names are silently routed by DeepSeek to its cheapest model — no error is raised**. `SettingsExecutors.vue` (68): deepseek_api joins the first-class (non-muted) type styling. `RunCard.vue` (116/119) and `Runs.vue` (250–251): the indicative-cost marker condition extends to `executor_type === 'deepseek_api'` with a provider-aware tooltip.
- **Rationale**: Spec FR-013/FR-014 and Story 6. The silent-substitution warning is the deepseek-specific delta vs the kimi hint (Moonshot fails on unknown models; DeepSeek substitutes).

## D9. Testing strategy

- **Decision**:
  - **Unit**: contract matrices in `executor.schema.spec.ts` / `agents-config.schema.spec.ts` (deepseek_api accepts harness knobs; rejects `auth`, `aws_*`, `ca_bundle_path`, base-URL-like fields — "auth/AWS fields are foreign to deepseek_api"; create-without-key 422; passthrough replacement doesn't loosen the union); `claude-cli.config.spec.ts` — `applyProviderEnv` with the deepseek preset (sets the DeepSeek constant; claude_cli preset stays a no-op; kimi preset keeps Moonshot); `claude-cli.executor.spec.ts` — keyless deepseek profile → loud error (generalized guard covers both types with per-type messages); `executors.module.spec.ts` — registry resolves `deepseek_api` to a preset-carrying `ClaudeCliExecutor` instance (and all four types resolve); `queues.module.spec.ts` — `run.deepseek_api` in the provisioned set; web: `executor-form.spec.ts` (field set, hint, key rules), `run-card.spec.ts` / `runs-table.spec.ts` (indicative marker for deepseek runs).
  - **Integration** (mirror the four kimi suites 1:1): `deepseek-run.spec.ts` (end-to-end through `run.deepseek_api` with fake-claude; child env contains `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + profile key; success/rate-limit/crash fixtures produce claude_cli-identical statuses), `deepseek-gate.spec.ts` (per-profile gate + live re-apply), `deepseek-security.spec.ts` (polluted shell: host `ANTHROPIC_BASE_URL`/keys absent everywhere; kimi child still gets Moonshot, claude_cli child gets no override; key never in timeline/diagnostics), `deepseek-executor-crud.spec.ts` (422 matrix, `has_api_key`, key never echoed).
  - **Regression floor**: entire existing claude_cli + kimi unit and integration suites pass **without modification** (spec SC-002). The D4 consolidation must not alter any existing accept/reject outcome.
- **Rationale**: Constitution VI; the kimi suites are the exact per-provider template.

## D10. Model naming: native ids, silent-substitution risk, smoke verification

- **Decision**: Profile `config.model` uses **native DeepSeek ids** (`deepseek-v4-pro`, `deepseek-v4-flash`). No save-time validation, no model catalog. The endpoint maps claude-style aliases and silently routes unrecognized names to `deepseek-v4-flash`; the mandatory smoke test verifies via usage/response logs that the configured native id passes through and actually serves the run. If native ids are silently remapped, the observed convention is documented in `contracts/deepseek-provider-env.md` and the form hint is corrected before merge.
- **Rationale**: Spec edge case + SC-005. `EXECUTOR_MODEL_LIMITS` caps key on the configured string — documented consequence (a substituted run is capped under the configured name), correction out of scope.

## D11. Smoke validation: callback-channel hypothesis, evidence, stop condition

- **Decision**: After green gates, one real run through a freshly created `deepseek_api` profile (`model: deepseek-v4-flash`, `use_callback_channel: true`, `max_parallel_runs: 1`; the key arrives ONLY via the create-request body → sealed blob). Acceptance evidence (spec FR-017): terminal status via the normal path (not fail-closed); callback events (`report_progress → Brigadir`) on the timeline — the client-side stdio MCP hypothesis (DeepSeek's "MCP unsupported" note concerns their server-side API connector, not the CLI's client-side channel); tool use in the worktree; `cost_usd`/usage populated or their absence documented as a known limitation in the spec contracts + architecture.md; env scrubber verified (key nowhere in timeline/diagnostics — mirror the kimi-security assertions manually against the live run).
- **Rationale**: This is the go/no-go hypothesis of the feature (spec Story 3). **Stop condition**: if the callback channel does not function against DeepSeek, stop and write up symptoms — the feature decision changes; no silent workaround (e.g. falling back to `use_callback_channel: false` as a default) may be applied.

## D12. Cost semantics

- **Decision**: `cost_usd` recorded as today (CLI self-reported, Anthropic price list) → indicative for deepseek_api, marked in UI (D8) and documented in architecture.md §4. No DeepSeek price table, no recalculation. If the smoke shows DeepSeek returns no usage at all, `cost_usd` may be null — recorded as a known limitation, not patched around.
- **Rationale**: Same honest-labeling minimum as 025 D10.

## Codebase facts for implementers (recon 2026-07-22)

- `'deepseek_api'` already present in BOTH `EXECUTOR_TYPES` lists (contracts:22, interface) — only `RUN_QUEUE_EXECUTOR_TYPES`, `ExecutorTypeSchema`, and the typed branches need edits.
- `passthroughExecutorConfig('deepseek_api')` currently in the config union (agents-config.schema.ts:169) — must be REPLACED by the typed branch, not left alongside (discriminated union would reject the duplicate discriminator).
- `WorkerLockBootstrap` (feature 027) hard-lists processors — forgetting it means the new queue is silently never consumed (D6). The kimi plan predates 027; do not copy its touch-point list blindly.
- `RunCard.vue` is at `apps/web/src/views/RunCard.vue` and SettingsExecutors at `apps/web/src/views/settings/SettingsExecutors.vue` (the brief's paths are approximate).
- Existing web spec files to extend: `executor-form.spec.ts`, `run-card.spec.ts`, `runs-table.spec.ts` (all in `apps/web/test/`).
- After contracts edits: `pnpm --filter @brigadir/contracts build` before running web tests/typecheck.

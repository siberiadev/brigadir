# Research: kimi executor type (025)

**Date**: 2026-07-19. No `NEEDS CLARIFICATION` markers existed in the Technical Context; this document records the design decisions (most were pre-decided in the feature input and validated against the codebase by recon) and the codebase facts they rest on.

## D1. First-class type vs provider field vs native kimi-cli

- **Decision**: New first-class executor type `kimi`; implementation = existing Claude CLI harness parameterized by a provider preset.
- **Rationale**: Provider attribution must live on the denormalized, immutable `runs.executor_type` column — `WHERE executor_type = 'kimi'` for analytics, and profile edits can never re-attribute history. A provider field inside `executors.config` jsonb is mutable and would silently re-attribute past runs. Moonshot's native `kimi-cli` would need a new stream parser (unstable format), a per-run `config.toml` generator (no env-based credentials), new fake-binary fixtures, and has no Stop-hook equivalent for report enforcement (Constitution IV).
- **Alternatives considered**: (a) `provider` field in `claude_cli` config — rejected (mutable attribution, jsonb analytics); (b) native `kimi-cli` adapter — deferred, possible later **under the same type name** because the type is provider identity, not harness identity.

## D2. Parameterization point: constructor preset, not subclass and not new auth mode

- **Decision**: `ClaudeCliExecutor` gains a constructor-level provider preset `{ type: ExecutorType; anthropicBaseUrl?: string }`. `readonly type = 'claude_cli' as const` (claude-cli.executor.ts:164) becomes `readonly type` assigned from the preset. Two DI instances are registered in the `AGENT_EXECUTORS` factory (executors.module.ts:20–26): `claude_cli` (no base URL) and `kimi` (Moonshot constant).
- **Rationale**: `ExecutorRegistry` already resolves by `executor.type` from the injected array (executor.registry.ts:9–21) — zero registry changes. A subclass-with-ifs duplicates behavior; a fourth `auth` mode inside `EffectiveAuth` would let *claude_cli* profiles select Moonshot (exactly the mutable-attribution hole D1 closes) — the preset is per-instance and outside profile config.
- **Alternatives considered**: subclass `KimiExecutor extends ClaudeCliExecutor` — rejected (no behavioral delta beyond two env vars; NestJS DI of two instances of one class via factory is simpler); `auth: 'moonshot'` mode — rejected (config-level = mutable, violates D1).
- **Note**: NestJS registers both instances via `useFactory` returning configured instances (not bare class providers), since the same class appears twice with different presets. `MockExecutor` stays a class provider.

## D3. Env injection: after allowlist, pure function beside `applyAuthEnv`

- **Decision**: A pure function (e.g. `applyProviderEnv(env, preset)` adjacent to `applyAuthEnv`, claude-cli.config.ts:118–136) sets `ANTHROPIC_BASE_URL` from the preset when present; the key is injected by the existing `api_key` path (`env.ANTHROPIC_API_KEY = apiKey`, line 122–124). Call order in `runProcess` (claude-cli.executor.ts:380–386): `buildChildEnv(process.env)` → `applyAuthEnv(...)` → `applyProviderEnv(...)` → `spawnGroup(...)`.
- **Rationale**: Mirrors feature-018 precedent exactly (bedrock injects `CLAUDE_CODE_USE_BEDROCK`/`AWS_*` post-allowlist from profile values). Pure function ⇒ unit-testable per preset. `ALLOWLIST_KEYS` (env-allowlist.ts:20–59) is documented as "the floor; do not extend it for auth modes" — `ANTHROPIC_BASE_URL` never joins it, so a host-level value can never pass `buildChildEnv` for any type, and injection exists only in the child env of a kimi run.
- **Alternatives considered**: extending `applyAuthEnv` with a preset param — acceptable variant; kept as implementation freedom, requirement is a *pure, per-mode unit-tested* function with the ordering above. Adding `ANTHROPIC_BASE_URL` to the allowlist — categorically rejected (host leak → silent redirect of any run's traffic).

## D4. Auth resolution for kimi: implicit api_key-only

- **Decision**: The kimi config branch has **no `auth` field**. At load time (`loadRunConfig`, claude-cli.executor.ts:562–746) a kimi-preset executor resolves auth as `{mode:'api_key'}` unconditionally and requires sealed secrets; `resolveEffectiveAuth`'s defaulting chain (claude-cli.config.ts:93) is bypassed/specialized for the kimi preset. Missing stored key at run time ⇒ fail-fast run failure with diagnostics (normal failed-run path).
- **Rationale**: `host_subscription` (Anthropic OAuth login) and `bedrock` are meaningless against Moonshot. Schema-level rejection of `auth`/`aws_*` fields (D5) plus controller-level key-required rules make a keyless kimi profile unrepresentable via the API.

## D5. Contracts: two schema layers, strict kimi branches

- **Decision**:
  - `packages/contracts/src/agents-config.schema.ts`: add `'kimi'` to `EXECUTOR_TYPES` (16–22) **and** `RUN_QUEUE_EXECUTOR_TYPES` (32); add `KimiExecutorConfigSchema` (camelCase stored shape) to the discriminated union (127–133) — clone of `ClaudeCliExecutorConfigSchema` (69–111) minus `auth`/`awsRegion`/`awsProfile`/`caBundlePath`; extend the two claude_cli `superRefine` checks (deprecated `repository` match at ~210, `allowedTools` at ~253) to also cover `kimi`.
  - `packages/contracts/src/executor.schema.ts`: add `'kimi'` to `ExecutorTypeSchema` (44); add `KimiExecutorApiConfigSchema` (snake_case, `.strict()`, `api_key` write-only nullable-optional) to `ExecutorApiConfigSchema`, `ExecutorCreateRequestSchema` (with a kimi key-required-on-create refinement mirroring lines 157–165) and `ExecutorUpdateRequestSchema` (173–177).
- **Rationale**: The repo deliberately keeps two copies of the type list (config-layer `EXECUTOR_TYPES` and interface-layer `EXECUTOR_TYPES` in agent-executor.interface.ts:7–13 — both must gain `'kimi'`) plus the narrow `ExecutorTypeSchema` for the two *implemented* API types. `RUN_QUEUE_EXECUTOR_TYPES` drives queue provisioning: `queues.module.ts:36–37` maps it through `runQueueName` into `BullModule.registerQueue` — adding the entry **is** the queue infrastructure work.
- **Alternatives considered**: `passthroughExecutorConfig('kimi')` (like anthropic_api stubs) — rejected: kimi is implemented, needs a typed, strict branch with the same knobs validation as claude_cli.

## D6. Worker processor: near-copy bound to `run.kimi`

- **Decision**: New `apps/worker/src/kimi-run.processor.ts` with `@Processor(runQueueName('kimi'), { concurrency: 2, maxStalledCount: 0, settings: { backoffStrategy } })`, sharing the `ClaudeCliRunProcessor` logic (claude-cli-run.processor.ts:68–75) via extracted shared base class or near-copy — whichever keeps `claude_cli` behavior byte-identical (snapshot/spec tests unchanged). Registered in `WorkerAppModule` providers (app.module.ts:44). Reuses `checkExecutorGate` (executor-gate.ts:38–80) and `applyExecutorConcurrency`/`startConcurrencyReapply` (executor-concurrency.ts:26–73) with `executorType: 'kimi'`.
- **Rationale**: `@Processor` bindings are per-class string literals — a distinct queue needs a distinct class. The gate/concurrency helpers are already parameterized by executor type/profile. `maxStalledCount: 0` is a CLAUDE.md rule-2 invariant and carries over.
- **Alternatives considered**: parameterizing one processor class over queue names — rejected: NestJS decorator metadata is static per class; dynamic processor registration is more machinery than a thin subclass. Composition-time `runQueueName('kimi')` call is permitted static structure (documented at call site, same as existing processors).

## D7. Backend dashboard: mapper coverage, no seeding

- **Decision**: Extend `executors.controller.ts` — `toInsertValues` (191–214) and `toExecutorResponse` (223–260) currently gate on `row.type === 'claude_cli'` (193, 226); kimi joins these branches (same snake↔camel field pairs minus auth/aws; response computes no `auth`, keeps `has_api_key: row.secrets != null`). The update-side rule (100–117, "must end with a key") applies to kimi unconditionally. `executor-seed.ts` / `ExecutorBackfillService`: **no kimi seeding** (clarification 2026-07-19) — no changes.
- **Rationale**: Key handling (sealApiKey → `sealExecutorSecrets`, AES-256-GCM under `BRIGADIR_CREDENTIALS_KEY`) is type-agnostic and reused as-is.

## D8. Web UI: kimi in selector; indicative-cost marker

- **Decision**: `ExecutorForm.vue`: add `kimi` `el-option` (type selector, lines 152–157) and a kimi field block (model, api_key, max_parallel_runs, cli_path, use_callback_channel, keep_failed_worktrees, max_turns) — **no URL field, no auth-mode selector, no AWS fields**; key-required-on-create enforced by form validation mirroring schema. Cost surfaces: `RunCard.vue` (~197, `meta-cost`) and `Runs.vue` (~193) show an "indicative" marker/tooltip when `executor_type === 'kimi'` (clarification 2026-07-19).
- **Rationale**: `run.executor_type` is already present in both views (RunCard.vue:108, Runs.vue table col 282) — the marker is a pure-frontend conditional, no API change. Aggregates (`SpendCard.vue`, `total_cost_usd`) keep summing as-is this iteration; the caveat lives at the run-level display + docs.

## D9. Testing strategy

- **Decision**:
  - **Unit**: contract matrices in `executor.schema.spec.ts` / `agents-config.schema.spec.ts` (kimi accepts harness knobs; rejects `auth`, `aws_*`, `ca_bundle_path`, base-URL-like fields; create-without-key rejected); `claude-cli.config.spec.ts` — `applyProviderEnv` per preset (kimi ⇒ `ANTHROPIC_BASE_URL` = Moonshot constant; claude_cli preset ⇒ absent; polluted host env never leaks — extend `env-allowlist.spec.ts` assertion style); executors.module factory registers both instances; `ExecutorRegistry.resolve('kimi')`.
  - **Integration** (mirror `claude-cli-bedrock.spec.ts` + `claude-cli-security.spec.ts`): kimi profile end-to-end through `run.kimi` with `FAKE_CLAUDE_*` harness — child env contains Moonshot `ANTHROPIC_BASE_URL` + profile key; host `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`OPENAI_*` pollution absent; success / rate-limit / crash paths behave identically to claude_cli **reusing existing NDJSON fixtures** (`stream-success.ndjson`, `stream-rate-limit.ndjson`, etc. — stream format unchanged, binary unchanged); executor CRUD (`executor-crud.spec.ts` pattern) for kimi create/update/key rules; gate/concurrency on the kimi queue.
  - **Regression floor**: entire existing claude_cli unit + integration suites (incl. `__snapshots__`) pass **without modification**.
- **Rationale**: Constitution VI; the bedrock feature established the exact per-auth-mode test template.

## D10. Cost semantics

- **Decision**: `cost_usd` recorded as today (CLI self-reported, Anthropic price list). Surfaced as indicative for kimi (D8) and documented in `architecture.md` §4. No Moonshot price table, no recalculation.
- **Rationale**: The CLI computes cost internally against Anthropic pricing; correcting it requires per-model Moonshot price data and a recalculation pass — deliberately out of scope; the honest minimum is labeling.

## Codebase discrepancies noted for implementers

- Two `EXECUTOR_TYPES` constants exist (interface layer vs contracts layer) with different orderings/membership — both need `'kimi'`; do not attempt to unify them in this iteration.
- `docs/architecture.md:341` names queues `queue:claude_cli` while runtime uses `run.<type>` via `runQueueName` — follow runtime naming (`run.kimi`); optionally fix the doc line while editing §4.
- `SeedExecutorRow.type` is `'mock' | 'claude_cli'` (executor-seed.ts:32) — stays unchanged since kimi is not seeded.

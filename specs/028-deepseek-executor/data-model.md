# Data Model: deepseek_api executor type (028)

**No DDL in this feature.** `executors.type` is text and `executors.config` is jsonb (docs/architecture.md §3, unchanged); `runs.executor_type` already exists and is denormalized at run creation. This document defines the new *logical* shapes only.

## Entity: Executor profile, type `deepseek_api`

Row in existing `executors` table.

| Column | Value for deepseek_api |
|---|---|
| `type` | `'deepseek_api'` (text; already in both `EXECUTOR_TYPES` lists; new member of `ExecutorTypeSchema` and `RUN_QUEUE_EXECUTOR_TYPES`) |
| `name` | operator-chosen, unique per existing rules |
| `enabled` | as today (gate returns `disabled` verdict when false) |
| `max_parallel_runs` | as today; summed into worker concurrency, enforced per-profile by executor gate |
| `config` | jsonb, camelCase — `DeepseekExecutorConfig` (below) |
| `secrets` | bytea — `sealExecutorSecrets({ api_key })`, AES-256-GCM under `BRIGADIR_CREDENTIALS_KEY`. **Required non-null for a usable deepseek_api profile** |

### Stored config shape — `DeepseekExecutorConfigSchema` (camelCase, `.strict()`)

Clone of `KimiExecutorConfigSchema` (itself claude_cli minus the auth surface). Replaces the former `passthroughExecutorConfig('deepseek_api')` stub in the union — the type graduates to typed+strict.

| Field | Type / default | Notes |
|---|---|---|
| `type` | literal `'deepseek_api'` | union discriminator |
| `concurrency` | int, default 2 | same semantics as claude_cli |
| `model` | string, required | **native DeepSeek id**: `deepseek-v4-pro` / `deepseek-v4-flash`; not validated against a catalog; unrecognized names are silently substituted by the provider (see contracts/deepseek-provider-env.md) |
| `cliPath` | string, default `'claude'` | harness binary |
| `repository` | optional, deprecated | same cross-check vs workspace repositories as claude_cli/kimi (shared `CLI_HARNESS_EXECUTOR_TYPES` superRefine) |
| `allowedTools` | optional string[] | same agent-level fallback rule as claude_cli/kimi (shared superRefine) |
| `keepFailedWorktrees` | boolean, default false | |
| `worktreeRoot`, `repoCacheRoot` | optional strings | |
| `maxTurns` | optional int | |
| `killGraceMs` | int, default 10000 (runtime clamp in `resolveClaudeCliConfig`); `cancelPollMs` int, default 3000 | |
| `useCallbackChannel` | boolean, default false | |

**Forbidden by `.strict()`**: `auth`, `awsRegion`/`awsProfile`/`caBundlePath`, any base-URL field. There is deliberately no endpoint field anywhere — the endpoint is the in-code constant `https://api.deepseek.com/anthropic` mapped from the type (provider preset).

### Validation rules (schema + controller)

1. **Create**: `api_key` (API layer, snake_case, write-only) required non-empty → sealed into `secrets`. Create without key ⇒ 422 (schema refinement: "deepseek_api requires an api_key on create", mirror of the kimi rule).
2. **Update**: must *end* with a key — either already stored (`secrets != null`) or provided in the same request; explicit key-clear that leaves no key ⇒ 422 (controller rule extended to the api-key-only type set).
3. Foreign fields (auth/aws/URL) ⇒ 422 via `.strict()`.
4. `api_key` never echoed; responses expose `has_api_key: secrets != null`; no `auth` field is computed for deepseek_api responses.

## Shared type-set constants (FR-016, new in `packages/contracts`)

| Constant | Members | Consumers |
|---|---|---|
| `CLI_HARNESS_EXECUTOR_TYPES` (agents-config layer, camelCase branch types) | `claude_cli`, `kimi`, `deepseek_api` | both `AgentsConfigSchema.superRefine` cross-field checks (deprecated `repository`, `allowedTools` fallback) |
| `CLI_HARNESS_API_EXECUTOR_TYPES` (API layer) | `claude_cli`, `kimi`, `deepseek_api` | `executors.controller.ts` mappings, `ExecutorForm.vue` `isCliHarness` |
| `API_KEY_ONLY_EXECUTOR_TYPES` (API layer) | `kimi`, `deepseek_api` | executor keyless fail-loud guard, controller key rules, `ExecutorForm.vue` `showApiKey`/no-Clear |

A fourth provider preset extends these constants — no parallel conditionals to hunt down.

## Entity: Run (existing — attribution only)

| Column | deepseek_api behavior |
|---|---|
| `executor_type` | `'deepseek_api'`, written at run creation from the agent's executor profile; **immutable** — later profile edits never rewrite it. Analytics: `WHERE executor_type = 'deepseek_api'` |
| `cost_usd` | recorded as reported by the CLI (Anthropic price list) — **indicative** for deepseek_api; UI marks it, docs caveat it. May be null if DeepSeek returns no usage (smoke finding to document) |
| everything else | identical lifecycle, statuses, guards (`runs_one_active`, `WHERE status='running'` finalization guards) |

## Queue: `run.deepseek_api` (BullMQ, transient)

- Name from `runQueueName('deepseek_api')`; provisioned automatically by `QueuesModule` from `RUN_QUEUE_EXECUTOR_TYPES` (adding `'deepseek_api'` there is the provisioning change).
- Same job options as `run.claude_cli` / `run.kimi`: BullMQ `deduplication`, `maxStalledCount: 0`.
- Consumed by new `DeepseekRunProcessor` (`@Processor(runQueueName('deepseek_api'), {... autorun: false})`), per-profile admission via `checkExecutorGate`, worker concurrency = Σ enabled deepseek_api profiles' `max_parallel_runs` via `applyExecutorConcurrency` + live re-apply.
- **Worker-lock gating (feature 027)**: the processor must be injected into `WorkerLockBootstrap` and included in its `workers()` array — otherwise the queue is provisioned but never consumed.

## Internal value object: Provider preset (extended)

`{ type: ExecutorType; anthropicBaseUrl?: string }` — constructor argument of `ClaudeCliExecutor`, fixed at DI composition:

| Instance | `type` | `anthropicBaseUrl` |
|---|---|---|
| claude_cli | `'claude_cli'` | `undefined` (never injected — byte-identical env) |
| kimi | `'kimi'` | `MOONSHOT_ANTHROPIC_BASE_URL` |
| deepseek_api | `'deepseek_api'` | `DEEPSEEK_ANTHROPIC_BASE_URL` |

Not persisted, not exposed via API, no operator surface. Effective auth for any api-key-only preset (`API_KEY_ONLY_EXECUTOR_TYPES`) is unconditionally `{ mode: 'api_key' }` with sealed-secrets requirement; a keyless profile fails loudly at run start (normal failed-run path).

## State transitions

None new. Run lifecycle, human-task flow, and finalization guards are shared with claude_cli/kimi unchanged.

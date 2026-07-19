# Data Model: kimi executor type (025)

**No DDL in this feature.** `executors.type` is text and `executors.config` is jsonb (docs/architecture.md §3, unchanged); `runs.executor_type` already exists and is denormalized at run creation. This document defines the new *logical* shapes only.

## Entity: Executor profile, type `kimi`

Row in existing `executors` table.

| Column | Value for kimi |
|---|---|
| `type` | `'kimi'` (text; new member of both `EXECUTOR_TYPES` lists and `ExecutorTypeSchema`) |
| `name` | operator-chosen, unique per existing rules |
| `enabled` | as today (gate returns `disabled` verdict when false) |
| `max_parallel_runs` | as today; summed into worker concurrency, enforced per-profile by executor gate |
| `config` | jsonb, camelCase — `KimiExecutorConfig` (below) |
| `secrets` | bytea — `sealExecutorSecrets({ api_key })`, AES-256-GCM under `BRIGADIR_CREDENTIALS_KEY`. **Required non-null for a usable kimi profile** |

### Stored config shape — `KimiExecutorConfigSchema` (camelCase, `.strict()`)

Clone of `ClaudeCliExecutorConfigSchema` **minus** `auth`, `awsRegion`, `awsProfile`, `caBundlePath` (and minus its bedrock superRefine):

| Field | Type / default | Notes |
|---|---|---|
| `type` | literal `'kimi'` | union discriminator |
| `concurrency` | int, default 2 | same semantics as claude_cli |
| `model` | string, required | e.g. `kimi-k3`, `kimi-k2.7`; not validated against a catalog |
| `cliPath` | string, default `'claude'` | harness binary |
| `repository` | optional, deprecated | same cross-check vs workspace repositories as claude_cli (superRefine extended) |
| `allowedTools` | optional string[] | same agent-level fallback rule as claude_cli (superRefine extended) |
| `keepFailedWorktrees` | boolean | |
| `worktreeRoot`, `repoCacheRoot` | optional strings | |
| `maxTurns` | optional int | |
| `killGraceMs` | default 5000; `cancelPollMs` default 3000 | |
| `useCallbackChannel` | boolean, default false | |

**Forbidden by `.strict()`**: `auth`, `awsRegion`/`awsProfile`/`caBundlePath`, any base-URL field. There is deliberately no endpoint field anywhere — the endpoint is the in-code constant `https://api.moonshot.ai/anthropic` mapped from the type (provider preset).

### Validation rules (schema + controller)

1. **Create**: `api_key` (API layer, snake_case, write-only) required non-empty → sealed into `secrets`. Create without key ⇒ 422 (schema refinement, mirrors claude_cli "auth api_key requires an api_key on create").
2. **Update**: must *end* with a key — either already stored (`secrets != null`) or provided in the same request; explicit key-clear that leaves no key ⇒ 422 (controller rule, extends executors.controller.ts:100–117 to kimi).
3. Foreign fields (auth/aws/URL) ⇒ 422 via `.strict()`.
4. `api_key` never echoed; responses expose `has_api_key: secrets != null`.

## Entity: Run (existing — attribution only)

| Column | kimi behavior |
|---|---|
| `executor_type` | `'kimi'`, written at run creation from the agent's executor profile; **immutable** — later profile edits never rewrite it. Analytics: `WHERE executor_type = 'kimi'` |
| `cost_usd` | recorded as reported by the CLI (Anthropic price list) — **indicative** for kimi; UI marks it, docs caveat it |
| everything else | identical lifecycle, statuses, guards (`runs_one_active`, `WHERE status='running'` finalization guards) |

## Queue: `run.kimi` (BullMQ, transient)

- Name from `runQueueName('kimi')`; provisioned automatically by `QueuesModule` from `RUN_QUEUE_EXECUTOR_TYPES` (adding `'kimi'` there is the provisioning change).
- Same job options as `run.claude_cli`: BullMQ `deduplication: { id: ticket:agent }`, `maxStalledCount: 0`.
- Consumed by new `KimiRunProcessor` (`@Processor(runQueueName('kimi'))`), per-profile admission via `checkExecutorGate`, worker concurrency = Σ enabled kimi profiles' `max_parallel_runs` via `applyExecutorConcurrency` + live re-apply.

## Internal value object: Provider preset

`{ type: ExecutorType; anthropicBaseUrl?: string }` — constructor argument of `ClaudeCliExecutor`, fixed at DI composition:

| Instance | `type` | `anthropicBaseUrl` |
|---|---|---|
| claude_cli | `'claude_cli'` | `undefined` (never injected — byte-identical env) |
| kimi | `'kimi'` | `MOONSHOT_ANTHROPIC_BASE_URL` constant |

Not persisted, not exposed via API, no operator surface. Effective auth for the kimi preset is unconditionally `{ mode: 'api_key' }` with sealed-secrets requirement.

## State transitions

None new. Run lifecycle, human-task flow, and finalization guards are shared with claude_cli unchanged.

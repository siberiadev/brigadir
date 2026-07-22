# Contract: Provider preset & child-environment injection (deepseek_api)

Governs how a deepseek_api run's child process env is constructed. This is the security-critical contract; violations are Constitution V regressions. Extends the mechanism contract of feature 025 (`specs/025-kimi-executor/contracts/kimi-provider-env.md`) with one preset row — the mechanism itself is unchanged.

## Constants

- `DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'` — in-code constant in `libs/executors/src/claude-cli/claude-cli.config.ts`, beside `MOONSHOT_ANTHROPIC_BASE_URL` with a twinned doc comment (module-scope static structure; permitted composition-time read, documented at the definition site). Never persisted, never in API/UI. DeepSeek's official Anthropic-compatible endpoint; tool use and streaming supported.
- `API_KEY_ONLY_EXECUTOR_TYPES = ['kimi', 'deepseek_api']` — shared constant (packages/contracts): the preset types with implicit api_key-only auth. The keyless fail-loud guard and all controller/form key rules key off this ONE set (spec FR-016) — never off per-type `if` chains.

## Provider preset (DI-time, per executor instance)

```
ProviderPreset = { type: ExecutorType, anthropicBaseUrl?: string }
```

| AGENT_EXECUTORS instance | preset |
|---|---|
| claude_cli | `{ type: 'claude_cli' }` — `anthropicBaseUrl` absent |
| kimi | `{ type: 'kimi', anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL }` |
| deepseek_api | `{ type: 'deepseek_api', anthropicBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL }` |

The deepseek_api instance is built by an explicit `useFactory` under a module-private `DEEPSEEK_EXECUTOR` symbol — registry-only resolution (by `type`), no class token, no subclass.

## Env construction order (in `runProcess`, per run — unchanged from 025)

1. `env = buildChildEnv(process.env)` — strict allowlist copy (`ALLOWLIST_KEYS`). **`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_*` are not on the allowlist and never will be.**
2. `applyAuthEnv(env, auth, apiKey)` — for any api-key-only preset, auth is unconditionally `{mode:'api_key'}`; sets `env.ANTHROPIC_API_KEY = apiKey` where `apiKey` = `openExecutorSecrets(row.secrets).api_key` (decrypted at spawn time only). A profile with `secrets == null` fails loudly BEFORE spawn (normal failed-run path, per-type error message).
3. `applyProviderEnv(env, preset)` — sets `env.ANTHROPIC_BASE_URL = preset.anthropicBaseUrl` **iff present**. No code change for this feature — the function is already preset-generic.
4. `spawnGroup(cliPath, argv, { cwd, env })` — env goes only to the child process group.

## Invariants (each has a dedicated test)

| # | Invariant | Test level |
|---|---|---|
| 1 | Host `ANTHROPIC_BASE_URL` never appears in any child env (any executor type), even when exported in the worker shell | unit (`buildChildEnv`) + integration (polluted-shell spawn) |
| 2 | claude_cli child env: no `ANTHROPIC_BASE_URL` key at all; kimi child env: Moonshot URL exactly — both byte-identical to pre-028 | unit per-preset + existing suites/snapshots unchanged |
| 3 | deepseek_api child env contains exactly `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_API_KEY=<profile key>` on top of the allowlisted floor | integration (fake-claude captures env) |
| 4 | Values sourced only from the constant + profile row — never `process.env` of the worker | code review + polluted-shell integration test |
| 5 | Key never in argv; never logged; scrubber masks it in timeline/diagnostics | integration (deepseek-security.spec.ts) + live smoke re-verification |
| 6 | Keyless deepseek_api profile → loud error naming the profile and provider, via the shared api-key-only guard (no silent host_subscription fallback) | unit (`claude-cli.executor.spec.ts`) |

## Model naming (provider behavior, verified by smoke)

- `config.model` carries **native DeepSeek ids**: `deepseek-v4-pro`, `deepseek-v4-flash`.
- The endpoint maps `claude-*` aliases to DeepSeek models and **silently routes unrecognized names to `deepseek-v4-flash`** — no error. Mitigations: form model-hint warning; the smoke test MUST verify via usage/response logs that the configured native id passes through and actually serves the run.
- If smoke shows native ids being remapped, THIS section is updated with the observed convention and the form hint corrected before merge.
- `EXECUTOR_MODEL_LIMITS` (executor-gate) keys on the configured `config.model` string — a silently-substituted run is capped under the configured name, not the serving model (documented, not corrected this iteration).

## Smoke validation (mandatory, spec FR-017 — after green gates)

Profile: `type: deepseek_api`, `model: deepseek-v4-flash`, `use_callback_channel: true`, `max_parallel_runs: 1`; the API key travels ONLY in the create-request body → sealed into `executors.secrets` (never committed, never in `.env`/specs/logs). One minimal real run; evidence required:

1. Terminal status via the normal path (not fail-closed).
2. Callback-channel events on the timeline (`report_progress → Brigadir` etc.) — **primary hypothesis**: the client-side stdio MCP works against DeepSeek (their "MCP unsupported" doc note concerns the server-side API connector). If it does NOT work: **stop, write up symptoms — no silent workaround**; the feature decision changes.
3. Tool use evidenced (files read/written in the worktree).
4. `cost_usd`/usage populated — or their absence recorded here and in architecture.md §4 as a known limitation.
5. Key absent from timeline/diagnostics (scrubber verified against the live run).

### Smoke RESULTS (executed 2026-07-22, real DeepSeek endpoint, `deepseek-v4-flash`, real `claude` 2.1.207)

- **(1) PASS** — run finished `succeeded`, `error: null`; schema-valid v2 report on the row.
- **(2) PASS — PRIMARY HYPOTHESIS CONFIRMED**: with `use_callback_channel: true` the report can only arrive via the client-side stdio MCP `complete_task`, and it did; the timeline additionally carries **3 `progress` events** (`report_progress → Brigadir`). DeepSeek's "MCP unsupported" note indeed concerns only their server-side API connector; the CLI's client-side MCP is unaffected.
- **(3) PASS** — 12 `tool_call` events; the agent created `SMOKE.md`, committed (`smoke: deepseek run`) and pushed the branch to the harness remote.
- **(4) KNOWN LIMITATION** — `cost_usd: null`, `usage: null`: DeepSeek's Anthropic-compatible endpoint returns **no usage metadata** through the CLI result, so deepseek_api runs carry no cost/usage at all (the UI shows "—"; the indicative marker applies only when a value exists). Consequence for model verification (SC-005): with no usage data, native-id pass-through cannot be independently confirmed from response metadata; the configured `deepseek-v4-flash` was accepted without error and the run was served (indistinguishable from the silent-fallback target, which is the same model). The documented convention stays: **use native ids**, and the form hint keeps the silent-substitution warning.
- **(5) PASS** — the live key appears nowhere in the run row or the timeline events (asserted programmatically against the live run).

## Non-goals

- No generic per-profile base URL (no config field, ever, this iteration).
- No new auth modes in `EffectiveAuth` for claude_cli profiles.
- No changes to `ALLOWLIST_KEYS`.
- No DeepSeek price table / cost recalculation (cost stays indicative).

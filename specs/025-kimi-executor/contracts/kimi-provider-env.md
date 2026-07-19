# Contract: Provider preset & child-environment injection (kimi)

Governs how a kimi run's child process env is constructed. This is the security-critical contract; violations are Constitution V regressions.

## Constants

- `MOONSHOT_ANTHROPIC_BASE_URL = 'https://api.moonshot.ai/anthropic'` — in-code constant in `libs/executors` (module-scope static structure; permitted composition-time read, documented at the definition site). Never persisted, never in API/UI.

## Provider preset (DI-time, per executor instance)

```
ProviderPreset = { type: ExecutorType, anthropicBaseUrl?: string }
```

| AGENT_EXECUTORS instance | preset |
|---|---|
| claude_cli | `{ type: 'claude_cli' }` — `anthropicBaseUrl` absent |
| kimi | `{ type: 'kimi', anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL }` |

## Env construction order (in `runProcess`, per run)

1. `env = buildChildEnv(process.env)` — strict allowlist copy (`ALLOWLIST_KEYS`). **`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_*` are not on the allowlist and never will be** — the allowlist file's "floor" comment stays authoritative.
2. `applyAuthEnv(env, auth, apiKey)` — for kimi, auth is unconditionally `{mode:'api_key'}`; sets `env.ANTHROPIC_API_KEY = apiKey` where `apiKey` = `openExecutorSecrets(row.secrets).api_key` (decrypted at spawn time only).
3. `applyProviderEnv(env, preset)` (new pure function beside `applyAuthEnv`) — sets `env.ANTHROPIC_BASE_URL = preset.anthropicBaseUrl` **iff present**. For the claude_cli preset it is a no-op (env object byte-identical to pre-feature).
4. `spawnGroup(cliPath, argv, { cwd, env })` — env goes only to the child process group.

## Invariants (each has a dedicated test)

| # | Invariant | Test level |
|---|---|---|
| 1 | Host `ANTHROPIC_BASE_URL` never appears in any child env (any executor type), even when exported in the worker shell | unit (`buildChildEnv`) + integration (polluted-shell spawn) |
| 2 | claude_cli child env after this feature == before this feature (no `ANTHROPIC_BASE_URL` key present at all) | unit per-preset + existing snapshots unchanged |
| 3 | kimi child env contains exactly `ANTHROPIC_BASE_URL=MOONSHOT_...` + `ANTHROPIC_API_KEY=<profile key>` on top of the allowlisted floor | integration (fake-claude captures env) |
| 4 | Values sourced only from the constant + profile row — never `process.env` of the worker | code review + polluted-shell integration test |
| 5 | Key never in argv; never logged; scrubber path unchanged | existing harness guarantees, re-asserted for kimi run |
| 6 | `applyProviderEnv` is pure (no I/O, no process.env reads) | unit |

## Non-goals

- No generic per-profile base URL (no config field, ever, this iteration).
- No new auth modes in `EffectiveAuth` for claude_cli profiles.
- No changes to `ALLOWLIST_KEYS`.

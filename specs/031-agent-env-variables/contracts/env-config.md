# Contract: Env configuration & injection (feature 031)

Authoritative shapes for the env feature. Zod sources land in `packages/contracts/src` (`env.schema.ts` + extensions of existing schemas); this document is the review contract.

## 1. Shared constants & value schema (`env.schema.ts` — dep-light, web-importable)

```ts
export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_ENV_KEYS: readonly string[];      // exact names — see research D5
export const RESERVED_ENV_PREFIXES: readonly string[];  // 'ANTHROPIC_', 'AWS_', 'CLAUDE_', 'FAKE_CLAUDE_', 'BRIGADIR_'
export const ENV_VALUE_MAX_BYTES = 8 * 1024;
export const ENV_TOTAL_MAX_BYTES = 64 * 1024;
export function isReservedEnvKey(key: string): boolean;

export const EnvMapSchema;        // Record<string,string>: every key passes ENV_KEY_REGEX + !isReservedEnvKey, value ≤ 8KB, summed ≤ 64KB
export const EnvWriteRowSchema;   // { key, value, secret: boolean } — UI/admin write row
```

Validation error contract (400 everywhere): message names the offending key — `env key "ANTHROPIC_API_KEY" is reserved` / `env key "2FOO" is invalid` / `env value for "BLOB" exceeds 8KB` / `env for scope exceeds 64KB` / `env key "PORT" is already defined as secret for this scope` (one-home conflict).

## 2. Contract extensions (existing schemas)

| Schema | File | Change |
|---|---|---|
| `WorkspaceRepositorySchema` | `jira.types.ts` | + `id: z.string().uuid().optional()`, + `env: EnvMapSchema.optional()` (strict object — explicit extension) |
| `WorkspaceSettingsRequestSchema` | `dashboard.schema.ts` | + `env: EnvMapSchema.optional()`; repositories entries accept `id`/`env` |
| `AgentBehaviorSchema` / `AgentBehaviorRequestSchema` | `agents-config.schema.ts` / `dashboard.schema.ts` | + `env: EnvMapSchema.optional()` |
| Workspace read responses | `dashboard.schema.ts` | + `env`, + `env_secret_keys: { workspace: string[]; repos: Record<repoId, string[]>; agents: Record<agentId, string[]> }` — NAMES ONLY, never values |
| Agent read responses | `dashboard.schema.ts` | behavior.env returned verbatim (non-secret); agent secret key names via workspace `env_secret_keys.agents[id]` |

## 3. Dashboard API

### 3.1 Env-secrets write endpoint (new; write-only)

```
PUT /api/workspaces/:id/env-secrets
Body: EnvSecretsWriteRequestSchema = {
  scope: 'workspace' | { repository_id: string } | { agent_id: string },
  set?: Record<string, string>,     // upsert secret values (validated like EnvMapSchema)
  delete?: string[],                // remove keys from the scope
}
→ 200 { env_secret_keys: ... }      // updated names-only view
```

Rules: read-modify-write of the sealed blob in one transaction; values never echoed; `repository_id` triggers repo-id backfill if the entry predates ids; unknown repository_id/agent_id → 404; key collision with a plaintext key in the same scope → 400 (one home per key).

### 3.2 Repository management (settings surface)

Existing `PUT /api/workspaces/:id/settings` continues to carry the full repositories array (now with `id` + `env`) and workspace `env`. Server-side normalization assigns missing repo ids and prunes `env_secrets.repos[id]` for deleted entries in the same transaction. The card UI uses this endpoint; no per-repo REST resource is introduced (array stays the storage model; the dialog edits one entry client-side).

### 3.3 Agent behavior

Existing agent write endpoint carries `behavior.env` (validated by the shared schema). Agent delete prunes `env_secrets.agents[agentId]`.

## 4. Admin-MCP

### 4.1 `create_workspace` (extended)

`repositories[]` entries accept `env?: AdminEnvRowSchema[]` where

```ts
AdminEnvRowSchema = {
  key: string,                       // same validation
  value?: string,                    // non-secret literal
  secret_from_env?: string,          // name of a variable in the MCP SERVER's process env;
}                                    // exactly one of value | secret_from_env
```

`secret_from_env` resolution happens inside the admin-MCP server process (operator exported it before launching Claude Code) — the secret value never enters model context (feature-030 token discipline). Missing variable → tool error naming the missing env var, workspace still created without that key? NO — fail atomically with a clear error (operator retries after exporting).

### 4.2 `set_env` (new tool)

```
set_env {
  workspace_id: string,
  scope: 'workspace' | { repository: string /* name or id */ } | { agent: string /* key */ },
  set?: AdminEnvRowSchema[],
  delete?: string[],
}
→ text result: scope, keys now configured (secret keys marked), keys deleted
```

Thin client of §3.1/§3.2 endpoints; resolves repository name → id and agent key → id via existing read endpoints. Tool description instructs the model to pass `secret_from_env` for anything sensitive.

## 5. Injection contract (executor)

```
applyUserEnv(env: Record<string,string>, userEnv: Record<string,string>): string[]
```

- Called in `ClaudeCliExecutor.runProcess` strictly between `buildChildEnv` and `applyAuthEnv`.
- Mutates `env` with `userEnv` entries; SKIPS any key where `isReservedEnvKey(key)` — returns the skipped list, which is logged as a run diagnostic (defensive layer; write surfaces should have rejected these).
- `ALLOWLIST_KEYS` untouched (test-guarded): a host variable absent from the allowlist and absent from user config MUST NOT appear in the child env even if named identically to a user key elsewhere.
- Repo-mounted runs only; `userEnv = {}` for triage/no-repo runs.
- Composition order (data-model.md "Effective run env") is normative; ties broken by "later layer wins".

## 6. Scrubber contract

```
makeScrub(extraLiterals: string[]): (text: string) => string
```

- Redacts each literal (length ≥ 4) with `[REDACTED]` before delegating to global `scrub()`.
- Executor builds it from ALL decrypted secret values in the run's merge and uses it for every persisted output: stream parser (`tool_call` inputs, progress), stderr tails/diagnostics, report persistence path.
- Global `scrub()` signature and behavior unchanged (all existing call sites unaffected).

## 7. Observable guarantees (test anchors)

1. Child process env contains merged user env with documented precedence (fake-claude `FAKE_CLAUDE_ENV_DUMP` harness).
2. Host env var not in `ALLOWLIST_KEYS` never reaches the child, with or without user env configured (T085 extension).
3. Reserved key via any write surface → 400 naming the key; reserved key in stored data → skipped at injection + diagnostic.
4. Secret value: accepted on write → present in child env → absent from every API read, run_event, report, Jira payload (integration, SC-003).
5. Config edit during a live run → no effect on that run; next run sees it (SC-002).
6. `env_secrets` unopenable + run references secrets → run fails pre-spawn with diagnostic; no spawn happens (D7).
7. Workspace with zero env config → child env byte-identical to pre-feature behavior (SC-005).

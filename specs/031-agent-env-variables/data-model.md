# Data Model: Environment variables for agent runs

## Overview

No new tables. One new nullable column on `workspaces`; everything else extends existing jsonb blobs and zod contracts. Docs obligation: `docs/architecture.md` §3 comments for `workspaces` and `agents.behavior` updated in the same change (constitution: schema doc must match DDL).

## DDL change

```sql
-- drizzle/0010_env_variables.sql
ALTER TABLE workspaces ADD COLUMN env_secrets bytea;
-- NULL = no secret env configured. Sealed JSON document (AES-256-GCM envelope,
-- key BRIGADIR_CREDENTIALS_KEY, same as jira_credentials / executors.secrets):
-- { workspace?: {KEY: value}, repos?: {repoId: {KEY: value}}, agents?: {agentId: {KEY: value}} }
-- WRITE-ONLY via API: read surfaces expose only key names (secret_keys per scope).
```

Drizzle schema: `libs/database/src/schema/workspaces.ts` gains `envSecrets: bytea('env_secrets')` (nullable), mirroring `agentInstructionsToken`.

## Entities

### EnvVar (value object — contracts)

| Field | Type | Rules |
|---|---|---|
| key | string | `ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/`; NOT in `RESERVED_ENV_KEYS` (exact) nor matching reserved prefixes (`ANTHROPIC_*`, `AWS_*`, `CLAUDE_*`, `FAKE_CLAUDE_*`, `BRIGADIR_*`); unique per scope instance |
| value | string | ≤ 8 KB; empty string allowed (`KEY=` ≠ unset) |
| secret | boolean | write-time routing flag: `false` → plaintext jsonb, `true` → sealed blob; not stored on the plaintext side |

Merged-set cap: total serialized size of the effective env for a run ≤ 64 KB (validated at write time per scope sum, defensively at compose time).

### Workspace env defaults (plaintext part)

`workspaces.settings.env?: Record<string,string>` — new optional key in the settings blob (documented in §3 comment alongside `repositories[]`). Applies to every repo-mounted run of the workspace.

### Repository entry (extended)

`workspaces.settings.repositories[]` entry (`WorkspaceRepositorySchema`, `packages/contracts/src/jira.types.ts:112` — `.strict()`, extended explicitly):

| Field | Type | Notes |
|---|---|---|
| id | string (uuid), optional | NEW — stable identity; lazily backfilled by normalization in `libs/database/src/workspace-settings.ts` on first settings write; required for `env_secrets.repos` keying and card-dialog addressing |
| name | string | existing |
| git_url | string | existing |
| default_branch | string | existing |
| env | Record<string,string>, optional | NEW — non-secret per-repo env; lives and dies with the entry (rename-safe, delete-cascades by construction) |

### Agent behavior (extended)

`agents.behavior.env?: Record<string,string>` — new optional key in `AgentBehaviorSchema` (`packages/contracts/src/agents-config.schema.ts`) and `AgentBehaviorRequestSchema` (`packages/contracts/src/dashboard.schema.ts`, `.passthrough()` — additive). Highest operator-precedence layer; applies only to that agent's repo-mounted runs.

### EnvSecretsDocument (sealed — `workspaces.env_secrets`)

```ts
// libs/executors/src/env-secrets.ts (codec mirrors executor-secrets.ts)
interface EnvSecretsDocument {
  workspace?: Record<string, string>;            // workspace-scope secret values
  repos?: Record<string, Record<string, string>>;   // repoId → secret values
  agents?: Record<string, Record<string, string>>;  // agentId → secret values
}
sealEnvSecrets(doc, key?) → Buffer          // sealSecret(JSON.stringify(doc))
openEnvSecrets(blob, key?) → EnvSecretsDocument  // throws SecretBoxError — never silent
```

Lifecycle rules:
- Deleting a repository entry MUST prune `repos[repoId]` in the same transaction (read-modify-write of the blob).
- Deleting an agent MUST prune `agents[agentId]` (agents.id is FK-stable; prune on delete path).
- A key present in both plaintext and sealed stores for the same scope is a write-time conflict (400) — one home per (scope, key).

## Effective run env (computed, never persisted)

```
base      = buildChildEnv(process.env)                     // allowlist floor — UNCHANGED
user      = workspace.env ⊕ workspace.secret(workspace)    // ⊕ = right side wins per key
            ⊕ for each mounted repo in mount order:
                repo.env ⊕ secrets.repos[repo.id]
            ⊕ agent.behavior.env ⊕ secrets.agents[agentId]
user      = dropReserved(user)                             // defensive filter, logged
effective = base ⊕ user ⊕ authEnv(profile) ⊕ providerEnv(preset)   // platform LAST — unoverridable
```

- Computed in `ClaudeCliExecutor.loadRunConfig` / applied in `runProcess` between `buildChildEnv` and `applyAuthEnv` (research D1).
- Repo-mounted runs only; triage/no-repo runs: `user = {}` (research D4).
- Fixed at spawn; never re-read for a live run.
- Secret values from the merge are registered with `makeScrub` for all persisted outputs (research D6).
- `openEnvSecrets` failure when secrets are referenced → run fails pre-spawn with diagnostics (research D7).

## State & migration notes

- Migration `0010` is additive (nullable column); existing workspaces behave identically (FR-014 / SC-005).
- Repo `id` backfill is lazy and idempotent; readers tolerate missing ids (pre-backfill rows) — only the secrets path requires an id, and the write path that stores a repo secret performs the backfill first.
- No changes to `runs`, `run_events`, queues, or indexes.

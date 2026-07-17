# Data Model — Bedrock authentication mode for Claude CLI executor profiles

**Feature**: 018-bedrock-auth-mode | **Date**: 2026-07-17

No new tables, columns, or migrations. `docs/architecture.md` §3 DDL is untouched. The delta is additive keys inside the existing `executors.config` jsonb plus a derived (never-stored) concept, the **effective auth mode**.

## Entity: Executor profile (`executors` row, `type = 'claude_cli'`) — extended

### Stored shape delta (`executors.config` jsonb, camelCase — runtime shape)

| Key | Type | Required | New? | Notes |
|---|---|---|---|---|
| `auth` | `'host_subscription' \| 'api_key' \| 'bedrock'` | no | **new** | Absent on every pre-018 row (→ defaulting rule below). Written only when the API request carries `auth`. |
| `awsRegion` | string (non-empty) | only when `auth='bedrock'` | **new** | e.g. `eu-west-1`. Injected as `AWS_REGION`. |
| `awsProfile` | string (non-empty) | no | **new** | Named `~/.aws` profile on the worker host. Absent → AWS SDK default credential chain. Injected as `AWS_PROFILE` iff present. |
| `caBundlePath` | string (non-empty) | no | **new** | Worker-host filesystem path; never validated at save time. Injected as `NODE_EXTRA_CA_CERTS` iff present. |
| `model`, `cliPath`, `useCallbackChannel`, `keepFailedWorktrees`, `maxTurns`, … | — | — | unchanged | Existing keys keep exact semantics; in bedrock mode `model` must be a full Bedrock model/inference-profile id (hint-level guidance, not validated). |

`executors.secrets` (bytea, sealed `{ api_key? }`) — **unchanged shape and codec**. Semantics refined: the blob is *used* (decrypted + injected) only when the effective auth mode is `api_key`; in other modes a stored blob is retained inert (spec FR-009).

### Wire shape delta (snake_case, `executor.schema.ts` claude_cli branch)

| Field | Type | Direction | Rules |
|---|---|---|---|
| `auth` | enum, optional | request + response | Response always carries the **effective** mode (see below), so clients/forms never re-implement defaulting. |
| `aws_region` | string, optional | request + response | Required (superRefine) iff `auth='bedrock'`; forbidden otherwise. |
| `aws_profile` | string, optional | request + response | Allowed only with `auth='bedrock'`. |
| `ca_bundle_path` | string, optional | request + response | Allowed only with `auth='bedrock'`. |
| `api_key` | string \| null, optional | request only (write-only, unchanged) | String allowed only with `auth='api_key'` (or legacy no-`auth` payloads); `null` (clear) allowed in any mode; create with `auth='api_key'` requires a string; update with `auth='api_key'` requires string-or-stored (controller check). `has_api_key` in responses unchanged. |

## Derived value: Effective auth mode (never stored)

```
effectiveAuth(config, hasStoredKey):
  config.auth                     if present
  'api_key'                       else if hasStoredKey (executors.secrets != null)
  'host_subscription'             otherwise
```

Computed by `resolveEffectiveAuth` (`libs/executors/src/claude-cli/claude-cli.config.ts`), consumed by:

- `ClaudeCliExecutor.loadRunConfig` — selects decryption + injection behavior;
- `executors.controller.ts#toExecutorResponse` — fills response `config.auth`.

## State/behavior mapping: effective mode → child environment delta

Applied by `applyAuthEnv` **after** `buildChildEnv` (allowlist floor unchanged; profile values only, never `process.env`):

| Effective mode | Injected keys (exact) |
|---|---|
| `host_subscription` | — (nothing) |
| `api_key` | `ANTHROPIC_API_KEY=<decrypted secrets.api_key>` |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION=<awsRegion>`, `AWS_PROFILE=<awsProfile>` (iff set), `NODE_EXTRA_CA_CERTS=<caBundlePath>` (iff set) |

Invariants (Constitution V / spec FR-005, FR-006):

1. `ALLOWLIST_KEYS` in `env-allowlist.ts` is not extended — host `AWS_*`, `ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK`, `NODE_EXTRA_CA_CERTS` never pass through.
2. No AWS access key / secret key / session token exists in `config`, `secrets`, any response, or any injected variable.
3. `api_key` decryption happens only in `api_key` mode (D4) — inert blobs are never materialized.

## Validation rules summary (where each lives)

| Rule | Layer |
|---|---|
| `bedrock` requires `aws_region`; bedrock fields foreign to other modes; `api_key` string foreign to non-`api_key` modes | shared zod `superRefine` (`executor.schema.ts`) — drives backend 422 AND form |
| create: `auth='api_key'` requires `api_key` string | create-request `superRefine` |
| update: `auth='api_key'` requires provided-or-stored key (`null`/omitted-with-no-blob → 422) | `executors.controller.ts` (needs row state) |
| unknown fields on any branch | existing `.strict()` (unchanged mechanism) |
| model-id format in bedrock mode | none (form hint only, D7/FR-011) |
| `ca_bundle_path` / `aws_profile` existence on worker host | none at save; run-time failure → failed run with diagnostics (FR-012) |

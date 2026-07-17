# Contract — `claude_cli` executor authentication modes

Extends the `claude_cli` branch of `ExecutorApiConfigSchema`
(`packages/contracts/src/executor.schema.ts`) and its stored/runtime mirror
(`ClaudeCliExecutorConfigSchema` in `agents-config.schema.ts`,
`ClaudeCliExecutorConfigInput` in `libs/executors`). Companion to feature
003's `contracts/executor-config.md` (still authoritative for the
non-auth fields) and the named-runner-profiles api_key semantics of
2026-07-14. Additive + refined: every pre-018 payload and stored row remains
valid unmodified.

## Wire fields (snake_case, claude_cli branch)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `auth` | `"host_subscription" \| "api_key" \| "bedrock"` | no | effective-auth rule (below) | Responses ALWAYS carry the effective mode; requests may omit (legacy clients). |
| `aws_region` | string ≥ 1 | iff `auth="bedrock"` | — | → stored `awsRegion` → injected `AWS_REGION`. |
| `aws_profile` | string ≥ 1 | no (bedrock only) | worker's AWS default chain | → stored `awsProfile` → injected `AWS_PROFILE` iff set. |
| `ca_bundle_path` | string ≥ 1 | no (bedrock only) | no extra trust | → stored `caBundlePath` → injected `NODE_EXTRA_CA_CERTS` iff set. Worker-host path; existence not validated at save. |
| `api_key` | string ≥ 1 \| null | create: iff `auth="api_key"` | tri-state (unchanged) | WRITE-ONLY, unchanged storage (sealed `executors.secrets`). String legal only for `auth="api_key"` or legacy no-`auth` payloads; `null` (clear) legal in any mode. |

All other claude_cli fields (`model`, `cli_path`, `use_callback_channel`,
`keep_failed_worktrees`, `max_turns`, `max_parallel_runs`, `name`) unchanged.

## Effective-auth defaulting rule (normative)

```
effective_auth = config.auth            when present
               = "api_key"             when absent AND a sealed api_key blob is stored
               = "host_subscription"   otherwise
```

- Single implementation: `resolveEffectiveAuth` (`libs/executors/src/claude-cli/claude-cli.config.ts`); consumed by the runtime and by `toExecutorResponse`.
- Stored rows are NEVER rewritten to materialize the default (additive-only guarantee).

## Cross-field validation

Shared `superRefine` (drives backend 422 and the Vue form identically):

1. `auth="bedrock"` → `aws_region` present and non-empty; issue path `aws_region`.
2. `auth` ≠ `"bedrock"` (or absent) → `aws_region`/`aws_profile`/`ca_bundle_path` forbidden; issue path = offending field.
3. `auth="host_subscription"` or `auth="bedrock"` → `api_key` must not be a string (`null` allowed); issue path `api_key`.
4. Create only: `auth="api_key"` → `api_key` string required; issue path `api_key`.

Controller-only (needs row state — `PUT /api/executors/:id`):

5. `auth="api_key"` and (`api_key: null`, or `api_key` omitted with no stored blob) → 422 `validation` with issue path `api_key` ("api_key mode requires a stored or provided key").

Mode-switch semantics: changing `auth` away from `"api_key"` does NOT clear the stored blob (inert retention); `api_key: null` remains the only clear operation.

## Storage mapping (`executors.config` jsonb, camelCase)

`auth` → `auth`; `aws_region` → `awsRegion`; `aws_profile` → `awsProfile`;
`ca_bundle_path` → `caBundlePath`. Written only when present in the request.
No migration; §3 DDL untouched.

## Child-environment contract (normative — Constitution V)

Injection happens strictly AFTER `buildChildEnv` (allowlist floor,
`env-allowlist.ts`, UNCHANGED), values sourced exclusively from the profile
row (never `process.env`):

| Effective mode | Exact injected variables |
|---|---|
| `host_subscription` | none |
| `api_key` | `ANTHROPIC_API_KEY` = decrypted `secrets.api_key` |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1`; `AWS_REGION`; `AWS_PROFILE` (iff `awsProfile` set); `NODE_EXTRA_CA_CERTS` (iff `caBundlePath` set) |

Guarantees:

- Host-shell `AWS_*`, `ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK`, `NODE_EXTRA_CA_CERTS` can never reach the child in ANY mode (allowlist-by-construction; canary-tested, T085 lineage).
- AWS credential material (access/secret/session) is never stored, never in any response, never injected; the CLI resolves credentials from `~/.aws` via allowlisted `HOME`.
- `secrets` blob is decrypted only when effective mode = `api_key`; decrypt failure there stays a hard error (misbill guard); inert blobs in other modes are never opened.

## Acceptance (traces spec FR-001..FR-009)

- Legacy payload/row without `auth`: validates; behaves per effective-auth rule; response `config.auth` shows the effective mode; child env byte-identical to pre-018 (SC-002).
- `{auth:"bedrock"}` without `aws_region` → 422 at `aws_region`.
- `{auth:"host_subscription", aws_region:"eu-west-1"}` → 422 at `aws_region` (foreign to mode).
- `{auth:"bedrock", api_key:"sk-..."}` → 422 at `api_key`; `{auth:"bedrock", api_key:null}` with stored key → accepted, blob cleared.
- Create `{auth:"api_key"}` without key → 422; update `{auth:"api_key"}` with stored blob and omitted key → accepted (keeps blob).
- Bedrock run with full config → fake-CLI env dump contains exactly the four injected variables with profile values; polluted host canaries absent.

## Example (create request)

```json
{
  "type": "claude_cli",
  "name": "corp-bedrock",
  "model": "eu.anthropic.claude-opus-4-8",
  "cli_path": "claude",
  "use_callback_channel": true,
  "keep_failed_worktrees": false,
  "max_turns": 30,
  "max_parallel_runs": 1,
  "auth": "bedrock",
  "aws_region": "eu-west-1",
  "aws_profile": "corp-dev",
  "ca_bundle_path": "/etc/ssl/corp/ca-bundle.pem"
}
```

Note the `model`: a full Bedrock model/inference-profile id — bare aliases
(`opus`) would resolve via `ANTHROPIC_DEFAULT_*_MODEL` env vars that are
deliberately not passed through (form shows this hint; not validated).

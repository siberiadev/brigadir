# Contract: Dashboard API for kimi executor profiles

Extends the existing `/api/executors` CRUD (DashboardTokenGuard). All shapes snake_case, zod `.strict()` in `packages/contracts/src/executor.schema.ts`. This contract adds a `kimi` branch to `ExecutorTypeSchema`, `ExecutorApiConfigSchema`, `ExecutorCreateRequestSchema`, `ExecutorUpdateRequestSchema` — the claude_cli and mock branches are untouched.

## `KimiExecutorApiConfigSchema` (request `config`)

```
{
  type: 'kimi',                    // literal, union discriminator
  model: string (min 1),           // e.g. "kimi-k3"
  cli_path?: string,               // default 'claude'
  use_callback_channel?: boolean,
  keep_failed_worktrees?: boolean,
  max_turns?: int > 0,
  max_parallel_runs?: int > 0,
  api_key?: string (min 1) | null  // WRITE-ONLY; null = explicit clear request
}
```

`.strict()` — unknown keys rejected. **Deliberately absent** (422 if sent): `auth`, `aws_region`, `aws_profile`, `ca_bundle_path`, any `base_url`/endpoint field.

## Create — `POST /api/executors`

- Body: `{ name, enabled?, config: KimiExecutorApiConfig }` per existing envelope.
- **Refinement (kimi branch)**: `api_key` must be a non-empty string on create. Message analog: `"kimi requires an api_key on create"`. Missing/null ⇒ 422.
- Effect: `api_key` sealed via `sealExecutorSecrets` into `executors.secrets`; stored `config` jsonb is the camelCase mapping (see below); row `type='kimi'`.

## Update — `PATCH/PUT /api/executors/:id`

- Same config branch, `api_key` optional: omitted ⇒ stored key retained; string ⇒ re-sealed; `null` ⇒ clear request.
- **Controller rule** (extends existing update-side api_key rule): the profile must *end* the update with a key available (stored or provided). Clearing to keyless ⇒ 422.

## Response — `ExecutorResponseSchema` (unchanged shape)

- `type: 'kimi'`, `config` echoes stored camelCase jsonb (as today for claude_cli), `has_api_key: boolean` (= `secrets != null`).
- `api_key` NEVER present in any response. No `auth` field is computed for kimi (implicitly api_key-only).
- No endpoint/base-URL appears in any response.

## snake ⇄ camel mapping (executors.controller.ts)

| API (snake) | Stored jsonb (camel) |
|---|---|
| `cli_path` | `cliPath` |
| `use_callback_channel` | `useCallbackChannel` |
| `keep_failed_worktrees` | `keepFailedWorktrees` |
| `max_turns` | `maxTurns` |
| `model` | `model` |
| `max_parallel_runs` | → `executors.max_parallel_runs` column (as today) |
| `api_key` | → sealed `executors.secrets` (never jsonb) |

## Error matrix (contract tests)

| Request | Result |
|---|---|
| create kimi, valid, with api_key | 201, `has_api_key: true` |
| create kimi without api_key | 422 (refinement) |
| create/update kimi with `auth: 'api_key'` | 422 (strict) |
| create/update kimi with `aws_region` (or profile/ca_bundle) | 422 (strict) |
| create/update kimi with any base-URL-like field | 422 (strict) |
| update kimi omitting api_key (key stored) | 200, key retained, `has_api_key: true` |
| update kimi `api_key: null` (no other key) | 422 (controller: must end with a key) |
| GET kimi profile | 200, no `api_key`, `has_api_key` present |

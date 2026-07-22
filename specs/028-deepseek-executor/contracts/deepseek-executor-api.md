# Contract: Dashboard API for deepseek_api executor profiles

Extends the existing `/api/executors` CRUD (DashboardTokenGuard). All shapes snake_case, zod `.strict()` in `packages/contracts/src/executor.schema.ts`. This contract adds a `deepseek_api` branch to `ExecutorTypeSchema`, `ExecutorApiConfigSchema`, `ExecutorCreateRequestSchema`, `ExecutorUpdateRequestSchema` — the mock, claude_cli, and kimi branches are untouched. Modeled 1:1 on `specs/025-kimi-executor/contracts/kimi-executor-api.md`.

## `DeepseekExecutorApiConfigSchema` (request `config`)

```
{
  type: 'deepseek_api',            // literal, union discriminator
  model: string (min 1),           // NATIVE DeepSeek id: "deepseek-v4-pro" | "deepseek-v4-flash"
  cli_path: string (min 1),
  use_callback_channel: boolean,
  keep_failed_worktrees: boolean,
  max_turns: int > 0,
  max_parallel_runs: int > 0,
  api_key?: string (min 1) | null  // WRITE-ONLY; null = explicit clear request
}
```

`.strict()` — unknown keys rejected. **Deliberately absent** (422 if sent): `auth`, `aws_region`, `aws_profile`, `ca_bundle_path`, any `base_url`/endpoint field. The endpoint is the code constant `DEEPSEEK_ANTHROPIC_BASE_URL` — never on the wire in either direction.

## Create — `POST /api/executors`

- Body: `{ name, enabled?, config: DeepseekExecutorApiConfig }` per existing envelope.
- **Refinement (deepseek_api branch)**: `api_key` must be a non-empty string on create. Message analog: `"deepseek_api requires an api_key on create"`. Missing/null ⇒ 422.
- Effect: `api_key` sealed via `sealExecutorSecrets` into `executors.secrets`; stored `config` jsonb is the camelCase mapping (below); row `type='deepseek_api'`.

## Update — `PUT /api/executors/:id`

- Same config branch, `api_key` optional: omitted ⇒ stored key retained; string ⇒ re-sealed; `null` ⇒ clear request.
- **Controller rule** (the existing update-side rule extended to the shared `API_KEY_ONLY_EXECUTOR_TYPES` set, not a third `if`): the profile must *end* the update with a key available (stored or provided). Clearing to keyless ⇒ 422, message `"deepseek_api requires a stored or provided api_key."`.

## Response — `ExecutorResponseSchema` (unchanged shape)

- `type: 'deepseek_api'`, `config` echoes stored camelCase jsonb, `has_api_key: boolean` (= `secrets != null`).
- `api_key` NEVER present in any response. No `auth` field is computed (implicitly api_key-only).
- No endpoint/base-URL appears in any response.

## snake ⇄ camel mapping (executors.controller.ts — same table as kimi)

| API (snake) | Stored jsonb (camel) |
|---|---|
| `cli_path` | `cliPath` |
| `use_callback_channel` | `useCallbackChannel` |
| `keep_failed_worktrees` | `keepFailedWorktrees` |
| `max_turns` | `maxTurns` |
| `model` | `model` |
| `max_parallel_runs` | → `executors.max_parallel_runs` column (as today) |
| `api_key` | → sealed `executors.secrets` (never jsonb) |

## UI contract (ExecutorForm / views)

- Type selector offers `deepseek_api`; selecting it shows the CLI-harness field set + API key block unconditionally (no auth selector, no AWS fields, no URL field, no Clear-key button).
- Model hint (`data-test="deepseek-model-hint"`): names `deepseek-v4-pro` / `deepseek-v4-flash`; states that cost figures are priced against Anthropic's list (indicative only) and that unrecognized model names are **silently routed by DeepSeek to its cheapest model**.
- Runs table + run card: cost value for `executor_type === 'deepseek_api'` carries the indicative marker/tooltip (same convention as kimi).

## Error matrix (contract tests)

| Request | Result |
|---|---|
| create deepseek_api, valid, with api_key | 201, `has_api_key: true` |
| create deepseek_api without api_key | 422 (refinement) |
| create/update deepseek_api with `auth` (any value) | 422 (strict) |
| create/update deepseek_api with `aws_region` (or profile/ca_bundle) | 422 (strict) |
| create/update deepseek_api with any base-URL-like field | 422 (strict) |
| update deepseek_api omitting api_key (key stored) | 200, key retained, `has_api_key: true` |
| update deepseek_api `api_key: null` (no other key) | 422 (controller: must end with a key) |
| GET deepseek_api profile | 200, no `api_key`, `has_api_key` present |

import { z } from 'zod';
import { makePaginatedResponseSchema } from './pagination.schema';

/**
 * Executors API contracts — NAMED RUNNER PROFILES (2026-07-14; platform-scoped
 * since 2026-07-13). An executor row is a runtime profile: transport type
 * (code registry — rows cannot create behavior) + model + limits + optional
 * credentials. The discriminated-union typed config is the SINGLE authority
 * for both backend validation and the Vue config form (mirrors feature 005's
 * shared linter). `snake_case` on the wire.
 *
 * Discriminated on `type`:
 *  - `mock`       → max_parallel_runs only.
 *  - `claude_cli` → model, cli_path, use_callback_channel,
 *                   keep_failed_worktrees, max_turns, max_parallel_runs
 *                   (+ write-only api_key on create/update)
 *                   (+ auth mode, feature 018: host_subscription | api_key |
 *                   bedrock, with aws_region/aws_profile/ca_bundle_path for
 *                   bedrock).
 *  - `kimi`       → same harness knobs as claude_cli but implicitly
 *                   api_key-only (feature 025): no auth selector, no AWS
 *                   fields, no base-URL field — the Moonshot endpoint is a
 *                   code constant mapped from the type.
 *  - `deepseek_api` → third provider preset over the same harness (feature
 *                   028): identical field set and key semantics as kimi; the
 *                   DeepSeek endpoint is a code constant mapped from the type.
 *
 * Auth defaulting (feature 018, additive — stored rows are never rewritten):
 * a row without `auth` behaves as `api_key` when it has a sealed api_key blob,
 * else as `host_subscription`. The single implementation is
 * `resolveEffectiveAuth` (libs/executors); responses always carry the
 * EFFECTIVE mode in `config.auth` so clients never re-derive it.
 *
 * `repository` is NOT an executor field: an executor is platform capacity and
 * has no workspace to resolve a repo against. A run's repository comes from
 * `agents.behavior.repository`, else the run workspace's default repository.
 * The profile's `model` is likewise the single source of truth — agents carry
 * no model (a legacy `behavior.model` is ignored by the runtime).
 *
 * `.strict()` on every branch is what rejects a field foreign to the type
 * (a `mock` may not carry `max_turns`).
 *
 * Persistence mapping: `max_parallel_runs` → `executors.max_parallel_runs`
 * (column); `name`/`type` → columns; every other typed field →
 * `executors.config` (jsonb, stored camelCase — the shape the executor runtime
 * already consumes). `api_key` is WRITE-ONLY: accepted on create/update,
 * AES-256-GCM-sealed into `executors.secrets`, NEVER serialized back — every
 * response carries `has_api_key: boolean` instead; `api_key: null` clears.
 */

export const ExecutorTypeSchema = z.enum(['mock', 'claude_cli', 'kimi', 'deepseek_api']);
export type ExecutorType = z.infer<typeof ExecutorTypeSchema>;

/**
 * Feature 028 (FR-016): the shared executor-type sets (CLI-harness /
 * api_key-only membership + guards) live in the DEP-FREE
 * `executor-type-sets.ts` module so the web app can consume the runtime
 * values from TS source via its vite alias (`@brigadir/contracts/
 * executor-type-sets` — same pattern as `pagination.constants.ts`; rollup
 * cannot trace names through the CJS barrel's `__exportStar`). Re-exported
 * here so server code keeps importing them from the barrel unchanged.
 */
export * from './executor-type-sets';

export const MockExecutorConfigSchema = z
  .object({
    type: z.literal('mock'),
    max_parallel_runs: z.number().int().min(1),
  })
  .strict();

/** Feature 018: how the spawned CLI authenticates (see header for defaulting). */
export const ClaudeCliAuthModeSchema = z.enum(['host_subscription', 'api_key', 'bedrock']);
export type ClaudeCliAuthMode = z.infer<typeof ClaudeCliAuthModeSchema>;

/**
 * Per-mode cross-field rules (feature 018, flat fields — a nested union would
 * break the additive wire shape and the form's flat error paths):
 *  - bedrock ⇒ aws_region required; the three bedrock fields are foreign to
 *    every other mode;
 *  - api_key as a STRING is only legal for auth "api_key" (or a legacy payload
 *    without `auth`); `null` (clear a stored key) stays legal in any mode.
 * The create-only rule (api_key mode requires a key) lives on the create
 * schema; the update-side variant needs stored state and lives in the
 * controller.
 */
function refineClaudeCliAuth(
  value: {
    auth?: ClaudeCliAuthMode;
    aws_region?: string;
    aws_profile?: string;
    ca_bundle_path?: string;
    api_key?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.auth === 'bedrock') {
    if (value.aws_region === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['aws_region'],
        message: 'aws_region is required when auth is "bedrock".',
      });
    }
  } else {
    for (const field of ['aws_region', 'aws_profile', 'ca_bundle_path'] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is only allowed when auth is "bedrock".`,
        });
      }
    }
  }
  if (
    (value.auth === 'bedrock' || value.auth === 'host_subscription') &&
    typeof value.api_key === 'string'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['api_key'],
      message: `api_key can only be provided when auth is "api_key" (null still clears a stored key).`,
    });
  }
}

export const ClaudeCliExecutorApiConfigSchema = z
  .object({
    type: z.literal('claude_cli'),
    model: z.string().min(1),
    cli_path: z.string().min(1),
    use_callback_channel: z.boolean(),
    keep_failed_worktrees: z.boolean(),
    max_turns: z.number().int().min(1),
    max_parallel_runs: z.number().int().min(1),
    // WRITE-ONLY: omitted → keep the stored key as-is; string → replace;
    // null → clear (run on the host subscription). Never echoed in responses.
    api_key: z.string().min(1).nullable().optional(),
    // Feature 018 — auth mode (optional on the wire for legacy payloads;
    // responses always carry the effective mode). Bedrock settings are
    // config, not credentials: AWS credentials stay in ~/.aws on the worker.
    auth: ClaudeCliAuthModeSchema.optional(),
    aws_region: z.string().min(1).optional(),
    aws_profile: z.string().min(1).optional(),
    ca_bundle_path: z.string().min(1).optional(),
  })
  .strict()
  .superRefine(refineClaudeCliAuth);

/**
 * `kimi` branch (feature 025) — the Claude CLI harness against Moonshot's
 * Anthropic-compatible endpoint. Implicitly api_key-only: there is NO `auth`
 * selector (host_subscription/bedrock are meaningless against Moonshot), no
 * AWS fields, and no base-URL field anywhere — the endpoint is a hardcoded
 * constant mapped from the type (contracts/kimi-provider-env.md). `.strict()`
 * rejects all of those as foreign. `api_key` keeps the claude_cli write-only
 * semantics; the create-time key-required rule lives on the create schema and
 * the update-side (provided-OR-stored) rule lives in the controller.
 */
export const KimiExecutorApiConfigSchema = z
  .object({
    type: z.literal('kimi'),
    model: z.string().min(1),
    cli_path: z.string().min(1),
    use_callback_channel: z.boolean(),
    keep_failed_worktrees: z.boolean(),
    max_turns: z.number().int().min(1),
    max_parallel_runs: z.number().int().min(1),
    // WRITE-ONLY: omitted → keep the stored key as-is; string → replace;
    // null → clear request (rejected by the controller when it would leave
    // the profile keyless — a keyless kimi profile cannot run).
    api_key: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * `deepseek_api` branch (feature 028) — the Claude CLI harness against
 * DeepSeek's Anthropic-compatible endpoint. Same shape and semantics as the
 * kimi branch: implicitly api_key-only (no `auth` selector, no AWS fields, no
 * base-URL field anywhere — the endpoint is a hardcoded constant mapped from
 * the type, contracts/deepseek-provider-env.md); `.strict()` rejects all of
 * those as foreign; `api_key` keeps the write-only semantics. `model` carries
 * a NATIVE DeepSeek id (`deepseek-v4-pro` / `deepseek-v4-flash`) — the
 * provider silently substitutes its cheapest model for unrecognized names, so
 * the form hint warns rather than the schema validating against a catalog.
 */
export const DeepseekExecutorApiConfigSchema = z
  .object({
    type: z.literal('deepseek_api'),
    model: z.string().min(1),
    cli_path: z.string().min(1),
    use_callback_channel: z.boolean(),
    keep_failed_worktrees: z.boolean(),
    max_turns: z.number().int().min(1),
    max_parallel_runs: z.number().int().min(1),
    // WRITE-ONLY: same tri-state as kimi; clear-to-keyless is the controller 422.
    api_key: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * The typed-config authority (discriminated union). Consumed by the backend
 * validation path AND the Vue form to drive the per-type field set.
 */
export const ExecutorApiConfigSchema = z.discriminatedUnion('type', [
  MockExecutorConfigSchema,
  ClaudeCliExecutorApiConfigSchema,
  KimiExecutorApiConfigSchema,
  DeepseekExecutorApiConfigSchema,
]);
export type ExecutorApiConfig = z.infer<typeof ExecutorApiConfigSchema>;

/**
 * POST /api/executors — typed config union + name. Credentials travel as the
 * typed `api_key` field (claude_cli branch) — the old free-form `secrets`
 * record is gone: a runner profile's secret surface is typed like the rest of
 * its config.
 */
const MockCreateBranch = MockExecutorConfigSchema.extend({ name: z.string().min(1) });
const ClaudeCliCreateBranch = ClaudeCliExecutorApiConfigSchema.extend({ name: z.string().min(1) });
const KimiCreateBranch = KimiExecutorApiConfigSchema.extend({ name: z.string().min(1) });
const DeepseekCreateBranch = DeepseekExecutorApiConfigSchema.extend({ name: z.string().min(1) });

export const ExecutorCreateRequestSchema = z.discriminatedUnion('type', [
  MockCreateBranch,
  // Create-only (feature 018): explicit api_key mode has no stored key to
  // fall back on, so the key must arrive in the same request. The update
  // variant of this rule (provided-OR-stored) lives in the controller.
  ClaudeCliCreateBranch.superRefine((value, ctx) => {
    if (value.auth === 'api_key' && typeof value.api_key !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['api_key'],
        message: 'auth "api_key" requires an api_key on create.',
      });
    }
  }),
  // Create-only (feature 025): kimi is implicitly api_key-only, so the key
  // must always arrive with the create. Update-side rule in the controller.
  KimiCreateBranch.superRefine((value, ctx) => {
    if (typeof value.api_key !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['api_key'],
        message: 'kimi requires an api_key on create.',
      });
    }
  }),
  // Create-only (feature 028): same rule for deepseek_api.
  DeepseekCreateBranch.superRefine((value, ctx) => {
    if (typeof value.api_key !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['api_key'],
        message: 'deepseek_api requires an api_key on create.',
      });
    }
  }),
]);
export type ExecutorCreateRequest = z.infer<typeof ExecutorCreateRequestSchema>;

/**
 * PUT /api/executors/:executorId — full update (same body shape, minus the
 * create-only api_key rule: an omitted key keeps the stored blob).
 */
export const ExecutorUpdateRequestSchema = z.discriminatedUnion('type', [
  MockCreateBranch,
  ClaudeCliCreateBranch,
  KimiCreateBranch,
  DeepseekCreateBranch,
]);
export type ExecutorUpdateRequest = z.infer<typeof ExecutorUpdateRequestSchema>;

/**
 * List item / create+update response. `config` is the non-concurrency typed
 * fields (snake_case). `has_api_key` reflects whether an encrypted key is
 * stored; the key itself is never a member of any response shape.
 */
export const ExecutorResponseSchema = z
  .object({
    id: z.string(),
    type: ExecutorTypeSchema,
    name: z.string(),
    enabled: z.boolean(),
    max_parallel_runs: z.number().int(),
    has_api_key: z.boolean(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ExecutorResponse = z.infer<typeof ExecutorResponseSchema>;

export const ExecutorListResponseSchema = makePaginatedResponseSchema(ExecutorResponseSchema);
export type ExecutorListResponse = z.infer<typeof ExecutorListResponseSchema>;

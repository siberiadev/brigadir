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
 *                   (+ write-only api_key on create/update).
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

export const ExecutorTypeSchema = z.enum(['mock', 'claude_cli']);
export type ExecutorType = z.infer<typeof ExecutorTypeSchema>;

export const MockExecutorConfigSchema = z
  .object({
    type: z.literal('mock'),
    max_parallel_runs: z.number().int().min(1),
  })
  .strict();

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
  })
  .strict();

/**
 * The typed-config authority (discriminated union). Consumed by the backend
 * validation path AND the Vue form to drive the per-type field set.
 */
export const ExecutorApiConfigSchema = z.discriminatedUnion('type', [
  MockExecutorConfigSchema,
  ClaudeCliExecutorApiConfigSchema,
]);
export type ExecutorApiConfig = z.infer<typeof ExecutorApiConfigSchema>;

/**
 * POST /api/executors — typed config union + name. Credentials travel as the
 * typed `api_key` field (claude_cli branch) — the old free-form `secrets`
 * record is gone: a runner profile's secret surface is typed like the rest of
 * its config.
 */
export const ExecutorCreateRequestSchema = z.discriminatedUnion('type', [
  MockExecutorConfigSchema.extend({ name: z.string().min(1) }),
  ClaudeCliExecutorApiConfigSchema.extend({ name: z.string().min(1) }),
]);
export type ExecutorCreateRequest = z.infer<typeof ExecutorCreateRequestSchema>;

/** PUT /api/executors/:executorId — full update (same body shape). */
export const ExecutorUpdateRequestSchema = ExecutorCreateRequestSchema;
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

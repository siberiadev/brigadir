import { z } from 'zod';

/**
 * Executors API contracts (feature 006, PLATFORM-scoped since 2026-07-13) —
 * the discriminated-union typed config that is the SINGLE authority for both
 * backend validation and the Vue config form (mirrors feature 005's shared
 * linter). `snake_case` on the wire.
 *
 * Discriminated on `type`:
 *  - `mock`       → concurrency only.
 *  - `claude_cli` → model, cli_path, use_callback_channel,
 *                   keep_failed_worktrees, max_turns, concurrency_limit.
 *
 * `repository` is NOT an executor field: an executor is platform capacity and
 * has no workspace to resolve a repo against. A run's repository comes from
 * `agents.behavior.repository`, else the run workspace's default repository.
 *
 * `.strict()` on every branch is what rejects a field foreign to the type
 * (a `mock` may not carry `max_turns`).
 *
 * Persistence mapping: `concurrency_limit` → `executors.concurrency_limit`
 * (column); `name`/`type` → columns; every other typed field →
 * `executors.config` (jsonb, stored camelCase — the shape the executor runtime
 * already consumes). `secrets` are write-only (encrypted at rest) and NEVER
 * serialized back.
 */

export const ExecutorTypeSchema = z.enum(['mock', 'claude_cli']);
export type ExecutorType = z.infer<typeof ExecutorTypeSchema>;

export const MockExecutorConfigSchema = z
  .object({
    type: z.literal('mock'),
    concurrency_limit: z.number().int().min(1),
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
    concurrency_limit: z.number().int().min(1),
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

const secretsField = z.record(z.string(), z.string()).optional();

/** POST /api/executors — typed config union + name (+ optional secrets). */
export const ExecutorCreateRequestSchema = z.discriminatedUnion('type', [
  MockExecutorConfigSchema.extend({ name: z.string().min(1), secrets: secretsField }),
  ClaudeCliExecutorApiConfigSchema.extend({ name: z.string().min(1), secrets: secretsField }),
]);
export type ExecutorCreateRequest = z.infer<typeof ExecutorCreateRequestSchema>;

/** PUT /api/executors/:executorId — full update (same body shape). */
export const ExecutorUpdateRequestSchema = ExecutorCreateRequestSchema;
export type ExecutorUpdateRequest = z.infer<typeof ExecutorUpdateRequestSchema>;

/** List item / create+update response. `config` is the non-concurrency typed fields (snake_case). */
export const ExecutorResponseSchema = z
  .object({
    id: z.string(),
    type: ExecutorTypeSchema,
    name: z.string(),
    enabled: z.boolean(),
    concurrency_limit: z.number().int(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ExecutorResponse = z.infer<typeof ExecutorResponseSchema>;

export const ExecutorListResponseSchema = z
  .object({ items: z.array(ExecutorResponseSchema) })
  .strict();
export type ExecutorListResponse = z.infer<typeof ExecutorListResponseSchema>;

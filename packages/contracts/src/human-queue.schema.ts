import { z } from 'zod';

/**
 * Human Queue API contracts (feature 006, contracts/human-queue-api.md) — the
 * global (cross-workspace) needs-human queue list (US1) and the navbar badge
 * count. The `resolve` endpoint already exists (feature 004,
 * `resolve-human-task.schema.ts`) and is reused unchanged. `snake_case` bodies.
 *
 * A list item carries open-task fields always; the closed-only fields
 * (`status`, `resolution`, `resolved_by`, `resolved_at`) are present when
 * listing `status=closed`.
 */

export const HumanTaskKindSchema = z.enum(['question', 'blocker', 'review']);
export type HumanQueueKind = z.infer<typeof HumanTaskKindSchema>;

export const HumanTaskClosedStatusSchema = z.enum(['resolved', 'dismissed']);
export type HumanTaskClosedStatus = z.infer<typeof HumanTaskClosedStatusSchema>;

export const HumanTaskTicketRefSchema = z
  .object({ key: z.string(), jira_url: z.string() })
  .strict();

export const HumanTaskAgentRefSchema = z.object({ id: z.string(), name: z.string() }).strict();

export const HumanQueueItemSchema = z
  .object({
    id: z.string(),
    kind: HumanTaskKindSchema,
    title: z.string(),
    details: z.string().nullable(),
    blocking: z.boolean(),
    ticket: HumanTaskTicketRefSchema,
    agent: HumanTaskAgentRefSchema.nullable(),
    run_id: z.string().nullable(),
    created_at: z.string(),
    // closed-only fields (present when status=closed):
    status: HumanTaskClosedStatusSchema.optional(),
    resolution: z.string().nullable().optional(),
    resolved_by: z.string().nullable().optional(),
    resolved_at: z.string().nullable().optional(),
  })
  .strict();
export type HumanQueueItem = z.infer<typeof HumanQueueItemSchema>;

export const HumanQueueListResponseSchema = z
  .object({ items: z.array(HumanQueueItemSchema) })
  .strict();
export type HumanQueueListResponse = z.infer<typeof HumanQueueListResponseSchema>;

export const HumanQueueStatusSchema = z.enum(['open', 'closed']);
export type HumanQueueStatus = z.infer<typeof HumanQueueStatusSchema>;

export const HumanQueueCountResponseSchema = z.object({ open: z.number().int() }).strict();
export type HumanQueueCountResponse = z.infer<typeof HumanQueueCountResponseSchema>;

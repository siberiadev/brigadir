import { z } from 'zod';

/**
 * `POST /api/human-tasks/:id/resolve` body (quickstart.md). Not an agent
 * callback tool — an operator/human action, unguarded this iteration
 * (Tasks UI is out of scope; answering via API/curl is acceptable).
 */
export const ResolveHumanTaskSchema = z
  .object({
    action: z.enum(['resume', 'done_manually', 'dismiss']),
    answer: z.string().max(4000).optional(),
    resolved_by: z.string().max(200).optional(),
    // feature 010 (FR-015): resume can target a DIFFERENT enabled worker agent
    // in the same workspace. Absent ⇒ resume the original agent (attempt+1).
    target_agent_id: z.string().uuid().optional(),
  })
  .strict();

export type ResolveHumanTaskInput = z.infer<typeof ResolveHumanTaskSchema>;

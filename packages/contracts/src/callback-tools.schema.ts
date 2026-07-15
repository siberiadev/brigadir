import { z } from 'zod';
import { ReportSchema, HUMAN_TASK_KINDS } from './report.schema';

/**
 * Callback tool argument schemas — one zod module, four future bindings
 * (stdio MCP / in-process SDK MCP / OpenAI functions / HTTP).
 * Normative source: docs/architecture.md §5.
 *
 * Shapes only in iteration 1; consumed from iteration 5 (CallbackModule/MCP).
 */

export const ReportProgressSchema = z
  .object({
    percent: z.number().min(0).max(100).optional(),
    stage: z.string(),
    message: z.string().max(500),
  })
  .strict();

export const RequestHumanSchema = z
  .object({
    kind: z.enum(HUMAN_TASK_KINDS),
    title: z
      .string()
      .max(120)
      .describe('One-line summary, plain text (no markdown) — shown as the task headline.'),
    details: z
      .string()
      .max(4000)
      .describe(
        'The task body in GitHub-flavored Markdown — the human reads this in a rendered viewer. ' +
          'Use headings, bullet/numbered lists, `inline code`, fenced ```code blocks```, **bold**, ' +
          'links, and blockquotes to make it scannable. Prefer short paragraphs and lists over one ' +
          'dense block. Do NOT wrap the whole thing in a single code fence.',
      ),
    blocking: z.boolean().default(true),
  })
  .strict();

/** complete_task carries the full structured report as its arguments. */
export const CompleteTaskSchema = ReportSchema;

export const CallbackTools = {
  report_progress: ReportProgressSchema,
  request_human: RequestHumanSchema,
  complete_task: CompleteTaskSchema,
} as const;

export type ReportProgressInput = z.infer<typeof ReportProgressSchema>;
export type RequestHumanInput = z.infer<typeof RequestHumanSchema>;

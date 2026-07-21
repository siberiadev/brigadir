import { z } from 'zod';
import { ReportSchema, HUMAN_TASK_KINDS } from './report.schema';
import { AnswerOptionsSchema } from './answer-option.schema';

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
    // feature 026 (FR-004): raised 500 → 4000 so agents can report fuller
    // messages; matches RequestHumanSchema.details. Over-limit is rejected at
    // intake (422), never silently truncated.
    message: z.string().max(4000),
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
    // feature 013: suggested answers, rendered as one-click buttons in the
    // human queue. Free text — scrubbed at intake like title/details.
    options: AnswerOptionsSchema.optional(),
  })
  .strict();

/** complete_task carries the full structured report as its arguments. */
export const CompleteTaskSchema = ReportSchema;

/**
 * Read-only Jira tools (feature 011, FR-008..011 / contracts/jira-read-tools.md)
 * — available to EVERY callback-wired run. Reads are served by the system with
 * the run workspace's own Jira access (agents never hold credentials); the
 * toolset exposes NO write operation (Principle III untouched). Search filters
 * are structured — never raw JQL — so workspace scoping is composed
 * server-side and cannot be escaped from the prompt.
 */
export const GetProjectOverviewSchema = z.object({}).strict();

export const SearchTicketsSchema = z
  .object({
    text: z.string().min(1).max(200).optional().describe('Free-text match on summary/description.'),
    status: z.string().min(1).max(100).optional().describe('Exact workflow status name.'),
    issue_type: z.string().min(1).max(100).optional().describe('Exact issue type name (e.g. Bug).'),
    max_results: z.number().int().min(1).max(50).optional().describe('Cap on returned tickets (default 20).'),
  })
  .strict();

export const GetTicketSchema = z
  .object({
    key: z.string().min(1).max(50).describe('Issue key within this workspace\'s project (e.g. PROJ-42).'),
  })
  .strict();

export const CallbackTools = {
  report_progress: ReportProgressSchema,
  request_human: RequestHumanSchema,
  complete_task: CompleteTaskSchema,
  get_project_overview: GetProjectOverviewSchema,
  search_tickets: SearchTicketsSchema,
  get_ticket: GetTicketSchema,
} as const;

export type ReportProgressInput = z.infer<typeof ReportProgressSchema>;
export type RequestHumanInput = z.infer<typeof RequestHumanSchema>;
export type SearchTicketsInput = z.infer<typeof SearchTicketsSchema>;
export type GetTicketInput = z.infer<typeof GetTicketSchema>;

import { z } from 'zod';

/**
 * Agent structured report — ReportSchema v1.
 * Normative source: docs/architecture.md §6
 * (https://brigadir.dev/schemas/agent-report/v1.json).
 *
 * The zod form round-trips the JSON Schema constraints, including
 * additionalProperties:false (.strict()) and the conditional rule that
 * outcome=needs_human REQUIRES human_task (Constitution Principle IV).
 */

export const REPORT_OUTCOMES = ['success', 'failure', 'needs_human', 'routed', 'team'] as const;
export const CHECK_STATUSES = ['pass', 'fail', 'skip', 'warn'] as const;
export const HUMAN_TASK_KINDS = ['question', 'blocker', 'review'] as const;

/**
 * Routing payload (feature 010, FR-001) — required when `outcome==='routed'`.
 * `target_agent` is a NAME resolved to an agent id in the pipeline (validated
 * there, not in the schema — orchestrator-vs-worker is workspace state, FR-002).
 * `task` passes the secret scrubber before persistence/Jira like every other
 * report field (FR-003).
 */
export const ReportRoutingSchema = z
  .object({
    target_agent: z
      .string()
      .max(200)
      .describe('Name of the enabled worker agent to hand the ticket back to.'),
    task: z
      .string()
      .max(4000)
      .describe(
        'Self-contained rework task in GitHub-flavored Markdown, framed as a fix of existing work.',
      ),
  })
  .strict();

/**
 * Team proposal (feature 011, FR-013) — required when `outcome==='team'`; only
 * an orchestrator's workspace-setup run may return it (FR-014, enforced in the
 * accept path, not the schema). Statuses and the executor profile are NAMES
 * validated against workspace state at completion-accept time (all-or-nothing;
 * an invalid proposal is rejected back to the agent as a 422 repair loop).
 * `description`/`instruction` pass the secret scrubber; identifiers do not.
 */
export const TeamAgentSchema = z
  .object({
    name: z.string().min(1).max(200).describe('Unique agent name (never the orchestrator\'s).'),
    description: z
      .string()
      .min(1)
      .max(500)
      .describe('One roster line: what this agent does (shown to the orchestrator in handoffs).'),
    instruction: z
      .string()
      .min(1)
      .max(8000)
      .describe('Self-contained role prompt in GitHub-flavored Markdown.'),
    trigger_status: z
      .string()
      .min(1)
      .max(100)
      .describe('Board workflow status that starts this agent.'),
    status_running: z.string().min(1).max(100).optional(),
    status_success: z.string().min(1).max(100),
    status_failure: z.string().min(1).max(100),
    executor: z
      .string()
      .min(1)
      .max(200)
      .describe('Executor PROFILE NAME (one of the enabled profiles listed in the handoff).'),
  })
  .strict();

export const ReportTeamSchema = z
  .object({
    agents: z.array(TeamAgentSchema).min(1).max(20),
  })
  .strict();

export const ReportCheckSchema = z
  .object({
    name: z.string().max(200),
    status: z.enum(CHECK_STATUSES),
    reason: z.string().max(1000).optional(),
  })
  .strict();

export const ReportHumanTaskSchema = z
  .object({
    kind: z.enum(HUMAN_TASK_KINDS),
    title: z
      .string()
      .max(120)
      .describe('One-line summary, plain text (no markdown) — shown as the task headline.'),
    details: z
      .string()
      .max(4000)
      .optional()
      .describe(
        'The task body in GitHub-flavored Markdown — the human reads this in a rendered viewer. ' +
          'Use headings, bullet/numbered lists, `inline code`, fenced ```code blocks```, **bold**, ' +
          'links, and blockquotes to make it scannable. Do NOT wrap the whole thing in a single code fence.',
      ),
  })
  .strict();

export const ReportArtifactsSchema = z
  .object({
    branch: z.string().optional(),
    pr_url: z.string().optional(),
    commits: z.array(z.string()).optional(),
    files_changed: z.number().int().optional(),
  })
  .strict();

export const ReportSchema = z
  .object({
    schema_version: z.literal(1),
    outcome: z.enum(REPORT_OUTCOMES),
    summary: z.string().max(2000),
    checks: z.array(ReportCheckSchema).max(50),
    human_task: ReportHumanTaskSchema.optional(),
    routing: ReportRoutingSchema.optional(),
    team: ReportTeamSchema.optional(),
    artifacts: ReportArtifactsSchema.optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.outcome === 'needs_human' && report.human_task === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['human_task'],
        message: 'human_task is required when outcome is "needs_human"',
      });
    }
    if (report.outcome === 'routed' && report.routing === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['routing'],
        message: 'routing is required when outcome is "routed"',
      });
    }
    if (report.outcome === 'team' && report.team === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['team'],
        message: 'team is required when outcome is "team"',
      });
    }
    if (report.outcome !== 'team' && report.team !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['team'],
        message: 'team is only allowed when outcome is "team"',
      });
    }
  });

export type ReportCheck = z.infer<typeof ReportCheckSchema>;
export type ReportHumanTask = z.infer<typeof ReportHumanTaskSchema>;
export type ReportRouting = z.infer<typeof ReportRoutingSchema>;
export type AgentReport = z.infer<typeof ReportSchema>;
export type HumanTaskKind = (typeof HUMAN_TASK_KINDS)[number];

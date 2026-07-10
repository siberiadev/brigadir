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

export const REPORT_OUTCOMES = ['success', 'failure', 'needs_human'] as const;
export const CHECK_STATUSES = ['pass', 'fail', 'skip', 'warn'] as const;
export const HUMAN_TASK_KINDS = ['question', 'blocker', 'review'] as const;

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
    title: z.string().max(120),
    details: z.string().max(4000).optional(),
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
    artifacts: ReportArtifactsSchema.optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.outcome === 'needs_human' && report.human_task === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['human_task'],
        message: 'human_task is required when outcome is "needs_human"',
      });
    }
  });

export type ReportCheck = z.infer<typeof ReportCheckSchema>;
export type ReportHumanTask = z.infer<typeof ReportHumanTaskSchema>;
export type AgentReport = z.infer<typeof ReportSchema>;

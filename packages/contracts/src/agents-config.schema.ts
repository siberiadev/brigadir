import { z } from 'zod';

/**
 * agents.yaml configuration schema.
 * Normative source: docs/spec.md §0.1 (Phase 0 config format).
 *
 * The executor `type` union includes `mock` (research F1 — additive to the
 * four real executor types in architecture §4) so the mock executor flows
 * through the real config/registry path.
 *
 * Validation failures surface the offending field path (zod issue paths),
 * which the loader (libs/app-config) turns into a fatal startup error.
 */

export const EXECUTOR_TYPES = [
  'mock',
  'claude_cli',
  'claude_routines',
  'anthropic_api',
  'deepseek_api',
] as const;

export const WorkspaceConfigSchema = z
  .object({
    jira_site: z.string().url(),
    project_key: z.string().min(1),
    repo: z.string().min(1),
    default_branch: z.string().min(1).default('main'),
  })
  .strict();

export const ExecutorConfigSchema = z
  .object({
    type: z.enum(EXECUTOR_TYPES),
    concurrency: z.number().int().min(1).default(2),
    model: z.string().optional(),
    routine_id: z.string().optional(),
  })
  // type-specific extras (e.g. cli path) are allowed through
  .passthrough();

export const AgentBehaviorSchema = z
  .object({
    reporting: z.string().optional(),
    human_escalation: z.string().optional(),
    on_failure: z.string().optional(),
    code_delivery: z.string().optional(),
    branch_prefix: z.string().optional(),
    allowed_tools: z.array(z.string()).optional(),
    required_checks: z.array(z.string()).optional(),
    verification: z.string().optional(),
  })
  .passthrough();

export const AgentConfigSchema = z
  .object({
    name: z.string().min(1),
    executor: z.string().min(1),
    instruction: z.string().min(1),
    trigger_status: z.string().optional(),
    trigger_jql: z.string().optional(),
    status_running: z.string().optional(),
    status_success: z.string().min(1),
    status_failure: z.string().min(1),
    timeout_minutes: z.number().int().positive().default(45),
    max_budget_usd: z.number().positive().optional(),
    max_attempts: z.number().int().min(1).default(2),
    behavior: AgentBehaviorSchema.optional(),
  })
  .strict();

export const AgentsConfigSchema = z
  .object({
    workspace: WorkspaceConfigSchema,
    executors: z.record(z.string(), ExecutorConfigSchema),
    agents: z.array(AgentConfigSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const executorNames = new Set(Object.keys(config.executors));
    const seenAgentNames = new Set<string>();
    config.agents.forEach((agent, index) => {
      if (!executorNames.has(agent.executor)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents', index, 'executor'],
          message: `references unknown executor "${agent.executor}"`,
        });
      }
      if (seenAgentNames.has(agent.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents', index, 'name'],
          message: `duplicate agent name "${agent.name}"`,
        });
      }
      seenAgentNames.add(agent.name);
    });
  });

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

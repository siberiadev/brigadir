import { z } from 'zod';
import { slugifyAgentKey } from './agent-key';

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

/**
 * The fixed registry of executor types the worker can actually RUN this
 * iteration → the source of the provisioned `run.<type>` queue set (feature 005,
 * R4/FR-018). Distinct from `EXECUTOR_TYPES` (the full config union, which still
 * lists not-yet-implemented types); only these get a BullMQ queue, so the queue
 * set no longer depends on `agents.yaml`. This is the "static structure" the
 * QueuesModule reads at composition time (Constitution lazy-resolution carve-out).
 */
export const RUN_QUEUE_EXECUTOR_TYPES = ['mock', 'claude_cli'] as const;

/** A git repository the workspace can operate on (validated now, consumed in iteration 3). */
export const RepositoryConfigSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().min(1),
    default_branch: z.string().min(1).default('main'),
  })
  .strict();

export const WorkspaceConfigSchema = z
  .object({
    jira_site: z.string().url(),
    project_key: z.string().min(1),
    // Board binding (iteration 2, plan-internal decision 5): required going
    // forward; the system introspects the board TYPE via the Agile API.
    board_id: z.number().int().positive(),
    // Optional global scope filter, ANDed into every reconciliation query (FR-038).
    scope_jql: z.string().min(1).optional(),
    // Forward-compat: validated for shape but unused until iteration 3 (FR-027/FR-039).
    branch_prefix: z.string().min(1).optional(),
    repositories: z.array(RepositoryConfigSchema).min(1).optional(),
    // Deprecated single-repo fields — kept optional for iteration-1 config back-compat.
    repo: z.string().min(1).optional(),
    default_branch: z.string().min(1).default('main'),
  })
  .strict();

/**
 * `claude_cli` executor branch (contracts/executor-config.md, iteration 3) —
 * typed and boot-validated, unlike the other (still-unimplemented) executor
 * types below. Cross-field checks (`repository` must reference a declared
 * workspace repository; `allowedTools` must resolve to a non-empty list)
 * live in `AgentsConfigSchema.superRefine` below, since they need the
 * workspace/agent context this branch alone doesn't have.
 */
export const ClaudeCliExecutorConfigSchema = z
  .object({
    type: z.literal('claude_cli'),
    concurrency: z.number().int().min(1).default(2),
    model: z.string().min(1),
    cliPath: z.string().min(1).default('claude'),
    repository: z.string().min(1),
    allowedTools: z.array(z.string()).optional(),
    keepFailedWorktrees: z.boolean().default(false),
    worktreeRoot: z.string().min(1).optional(),
    repoCacheRoot: z.string().min(1).optional(),
    maxTurns: z.number().int().min(1).optional(),
    killGraceMs: z.number().int().min(0).default(5000),
    cancelPollMs: z.number().int().min(1).default(3000),
    // Feature 004 (D6): explicit opt-in to the MCP callback channel. When
    // true, the executor drops --json-schema and wires the run onto
    // mcp-config + Stop hook instead; omitted/false keeps the iteration-3
    // structured-output path byte-for-byte unchanged.
    useCallbackChannel: z.boolean().default(false),
  })
  .strict();

/** Shape shared by the executor types that have no typed extension yet. */
function passthroughExecutorConfig<T extends string>(type: T) {
  return z
    .object({
      type: z.literal(type),
      concurrency: z.number().int().min(1).default(2),
      model: z.string().optional(),
      routine_id: z.string().optional(),
    })
    // type-specific extras are allowed through until each type gets its own
    // typed branch (this is what claude_cli just graduated out of).
    .passthrough();
}

export const ExecutorConfigSchema = z.discriminatedUnion('type', [
  ClaudeCliExecutorConfigSchema,
  passthroughExecutorConfig('mock'),
  passthroughExecutorConfig('claude_routines'),
  passthroughExecutorConfig('anthropic_api'),
  passthroughExecutorConfig('deepseek_api'),
]);

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
    // feature 014: the agent's function; feeds the derived key (name may repeat).
    role: z.string().min(1).optional(),
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
    // feature 014: identity is the derived key, not the name — two agents that
    // slug to the same key would collide on insert, so reject at config load.
    const seenAgentKeys = new Set<string>();
    config.agents.forEach((agent, index) => {
      if (!executorNames.has(agent.executor)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'executor'],
          message: `references unknown executor "${agent.executor}"`,
        });
      }
      const key = slugifyAgentKey(agent.name, agent.role ?? null);
      if (seenAgentKeys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'name'],
          message: `duplicate agent key "${key}" (from name "${agent.name}"${agent.role ? ` + role "${agent.role}"` : ''})`,
        });
      }
      seenAgentKeys.add(key);
    });

    // claude_cli cross-field checks (contracts/executor-config.md, D9):
    // `repository` must reference a declared workspace repository.
    const repoNames = new Set((config.workspace.repositories ?? []).map((r) => r.name));
    for (const [name, executor] of Object.entries(config.executors)) {
      if (executor.type !== 'claude_cli') continue;
      if (!repoNames.has(executor.repository)) {
        ctx.addIssue({
          code: 'custom',
          path: ['executors', name, 'repository'],
          message: `references unknown repository "${executor.repository}" — must match one of workspace.repositories[].name`,
        });
      }
    }

    // claude_cli `allowedTools`: if the executor doesn't declare its own,
    // every agent using it must declare a non-empty behavior.allowed_tools —
    // no silent "all tools" default (Constitution V posture).
    config.agents.forEach((agent, index) => {
      const executor = config.executors[agent.executor];
      if (!executor || executor.type !== 'claude_cli') return;
      if (executor.allowedTools && executor.allowedTools.length > 0) return;
      const behaviorTools = agent.behavior?.allowed_tools;
      if (!behaviorTools || behaviorTools.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'behavior', 'allowed_tools'],
          message: `agent "${agent.name}" uses claude_cli executor "${agent.executor}" but neither the executor's allowedTools nor the agent's behavior.allowed_tools declare any tools`,
        });
      }
    });
  });

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

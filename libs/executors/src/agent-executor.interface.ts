/**
 * AgentExecutor contract — verbatim from architecture §4, with the additive
 * `mock` type (research F1). One interface, many implementations; the executor
 * knows nothing about Jira or BullMQ.
 */

export const EXECUTOR_TYPES = [
  'mock',
  'claude_cli',
  'anthropic_api',
  'deepseek_api',
  'claude_routines',
] as const;

export type ExecutorType = (typeof EXECUTOR_TYPES)[number];

export type ExitStatus = 'completed' | 'crashed' | 'timeout' | 'rate_limited' | 'cancelled';

export interface RunContext {
  runId: string;
  ticket: { key: string; summary: string; description: string; url: string };
  instruction: string;
  workspaceDir: string | null;
  callback: { httpBaseUrl: string; runToken: string; mcpStdioCmd?: string[] };
  limits: { timeoutMs: number; maxBudgetUsd?: number; maxTurns?: number };
  env: Record<string, string>;
}

export interface ExecutorResult {
  exitStatus: ExitStatus;
  externalRef?: string;
  costUsd?: number;
  usage?: unknown;
  diagnostics?: string;
  /**
   * Mock-specific in-band report channel (contracts C1). Real executors deliver
   * the report via CallbackModule (iteration 5); the mock returns it here and it
   * passes the SAME `ReportSchema` gate in the processor.
   */
  report?: unknown;
}

export interface AgentExecutor {
  readonly type: ExecutorType;
  run(ctx: RunContext, signal: AbortSignal): Promise<ExecutorResult>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/** Multi-provider token: every AgentExecutor implementation registers under this. */
export const AGENT_EXECUTORS = Symbol('AGENT_EXECUTORS');

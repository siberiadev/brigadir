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
  // Null for ticketless workspace-setup runs (feature 011, D4) — the wrapper
  // renders a workspace-setup header instead of the ticket header.
  // `components` (feature 020): the ticket's Jira component names, repo-scoping
  // input. `null` ⇔ the dispatch-time Jira fetch failed (unknown), which an
  // active scoping gate treats as undeterminable; `[]` ⇔ ticket has none.
  ticket: { key: string; summary: string; description: string; url: string; components: string[] | null } | null;
  instruction: string;
  workspaceDir: string | null;
  callback: { httpBaseUrl: string; runToken: string; mcpStdioCmd?: string[] };
  limits: { timeoutMs: number; maxBudgetUsd?: number; maxTurns?: number };
  env: Record<string, string>;
  /**
   * Feature 004 (FR-016/018): true when this run's attempt was created by
   * ResumeService (`trigger_event.source === 'human-resume'`). The claude_cli
   * executor uses this to CONTINUE the same ticket branch instead of the
   * normal "fail loud if the branch already exists" crash-retry guard
   * (worktree.ts) — a resumed attempt is a deliberate continuation, not a
   * stale/unsafe leftover.
   */
  isResumedAttempt?: boolean;
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

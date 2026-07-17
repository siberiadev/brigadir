import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorConfig } from '@brigadir/contracts';

/** The `claude_cli` branch of `ExecutorConfigSchema` (already zod-defaulted). */
export type ClaudeCliExecutorConfig = Extract<ExecutorConfig, { type: 'claude_cli' }>;

/**
 * Platform default toolset for a REPO-MOUNTED run when neither the executor
 * profile (`config.allowedTools`) nor the agent (`behavior.allowed_tools`)
 * declares any (ST3-768). Under `--permission-mode dontAsk` an empty allowlist
 * auto-denies every mutating tool — the agent can read the repo but never
 * write, branch, or push, which no repo-mounted run ever wants. Generated
 * teams (`behavior: {}`) and the seeded `claude` profile hit exactly this.
 * Explicit config on either level still wins; no-repo (triage) runs keep the
 * empty allowlist — they have no workspace to mutate.
 *
 * `Bash` is deliberately unrestricted: the real guardrails are the per-run git
 * worktree, the run timeout, and the budget — tool-level narrowing is the
 * OPERATOR's per-profile/per-agent override (e.g. a read-only reviewer), not
 * the default. Read-only tools (Read/Glob/Grep) are listed for explicitness
 * even though dontAsk auto-allows them.
 */
export const DEFAULT_REPO_RUN_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Skill',
  'Bash',
  'WebFetch',
  'WebSearch',
];

/**
 * What's actually stored in `executors.config` (the DB jsonb column) at
 * runtime — the discriminant `type` and shared `concurrency` live in their
 * own columns, so the jsonb blob is everything else in the branch.
 * `repository` is NOT part of the executor config (platform-scoped executors,
 * 2026-07-13): a run's repository comes from `agents.behavior.repository`,
 * else the run workspace's default; a leftover key in old rows is ignored.
 */
export type ClaudeCliExecutorConfigInput = Omit<
  ClaudeCliExecutorConfig,
  'type' | 'concurrency' | 'repository'
>;

/** Fully-defaulted runtime shape the executor consumes — no optional fields left. */
export interface ClaudeCliRuntimeConfig {
  model: string;
  cliPath: string;
  allowedTools: string[];
  keepFailedWorktrees: boolean;
  worktreeRoot: string;
  repoCacheRoot: string;
  maxTurns?: number;
  killGraceMs: number;
  cancelPollMs: number;
  /** Feature 004 (D6): explicit opt-in to the MCP callback channel. */
  useCallbackChannel: boolean;
}

/**
 * Resolve the boot-validated `claude_cli` config branch into the runtime
 * shape (D9/contracts/executor-config.md). Pure — no I/O; `os.tmpdir()` is a
 * process-metadata read, not a filesystem/network call, and every default
 * here mirrors the contract's documented default column.
 */
export function resolveClaudeCliConfig(
  raw: ClaudeCliExecutorConfigInput,
  agentAllowedTools: readonly string[] = [],
): ClaudeCliRuntimeConfig {
  return {
    model: raw.model,
    cliPath: raw.cliPath,
    allowedTools:
      raw.allowedTools && raw.allowedTools.length > 0 ? raw.allowedTools : [...agentAllowedTools],
    keepFailedWorktrees: raw.keepFailedWorktrees,
    worktreeRoot: raw.worktreeRoot ?? join(tmpdir(), 'brigadir', 'worktrees'),
    repoCacheRoot: raw.repoCacheRoot ?? join(tmpdir(), 'brigadir', 'repos'),
    maxTurns: raw.maxTurns,
    killGraceMs: raw.killGraceMs,
    cancelPollMs: raw.cancelPollMs,
    useCallbackChannel: raw.useCallbackChannel,
  };
}

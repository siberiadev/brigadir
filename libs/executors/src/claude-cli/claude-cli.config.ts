import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorConfig } from '@brigadir/contracts';

/** The `claude_cli` branch of `ExecutorConfigSchema` (already zod-defaulted). */
export type ClaudeCliExecutorConfig = Extract<ExecutorConfig, { type: 'claude_cli' }>;

/**
 * What's actually stored in `executors.config` (the DB jsonb column) at
 * runtime — the discriminant `type` and shared `concurrency` live in their
 * own columns, so the jsonb blob is everything else in the branch.
 */
export type ClaudeCliExecutorConfigInput = Omit<ClaudeCliExecutorConfig, 'type' | 'concurrency'>;

/** Fully-defaulted runtime shape the executor consumes — no optional fields left. */
export interface ClaudeCliRuntimeConfig {
  model: string;
  cliPath: string;
  repository: string;
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
    repository: raw.repository,
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

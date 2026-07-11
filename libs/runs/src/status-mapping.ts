import type { ExitStatus } from '@brigadir/executors';
import type { AgentReport } from '@brigadir/contracts';

/**
 * Pure `ExecutorResult.exitStatus` → run outcome decision (research D4 /
 * architecture §4). Unit-tested exhaustively over exitStatus × outcome.
 *
 * - `completed` maps by report outcome → succeeded | failed | awaiting_human
 * - `crashed`   → retry while attempts remain, else failed
 * - `timeout`   → timed_out
 * - `rate_limited` → re-queue (no attempt consumed)
 * - `cancelled` → cancelled
 */

export type TerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'awaiting_human';

export type MapResult =
  | { action: 'finalize'; status: TerminalStatus }
  | { action: 'retry' }
  | { action: 'rate_limit' };

export interface MapInput {
  exitStatus: ExitStatus;
  /** Report outcome when `exitStatus === 'completed'`. */
  outcome?: AgentReport['outcome'];
  /** BullMQ `attemptsMade` for the current attempt (0-based on first run). */
  attemptsMade: number;
  /** Configured attempt budget (`agent.max_attempts`). */
  maxAttempts: number;
}

export function mapExitStatusToRunStatus(input: MapInput): MapResult {
  const { exitStatus, outcome, attemptsMade, maxAttempts } = input;

  switch (exitStatus) {
    case 'completed':
      switch (outcome) {
        case 'success':
          return { action: 'finalize', status: 'succeeded' };
        case 'failure':
          return { action: 'finalize', status: 'failed' };
        case 'needs_human':
          return { action: 'finalize', status: 'awaiting_human' };
        default:
          // completed without a valid report outcome ⇒ failed with diagnostics
          return { action: 'finalize', status: 'failed' };
      }
    case 'crashed': {
      const attemptsRemain = attemptsMade + 1 < maxAttempts;
      return attemptsRemain ? { action: 'retry' } : { action: 'finalize', status: 'failed' };
    }
    case 'timeout':
      return { action: 'finalize', status: 'timed_out' };
    case 'rate_limited':
      return { action: 'rate_limit' };
    case 'cancelled':
      return { action: 'finalize', status: 'cancelled' };
    default: {
      // exhaustiveness guard
      const _never: never = exitStatus;
      return _never;
    }
  }
}

/**
 * Pure Stop-hook decision (contracts/stop-hook-settings.md, FR-022/FR-023).
 * Extracted from stop-hook.ts so the bound (`stop_hook_active`) and the
 * marker check are unit-testable without spawning a process or touching
 * real stdin.
 */
export interface StopHookDecision {
  markerExists: boolean;
  stopHookActive: boolean;
}

export type StopHookResult = { decision: 'block'; reason: string } | { allow: true };

const BLOCK_REASON =
  'You must call mcp__brigadir__complete_task with your final report, or mcp__brigadir__request_human, before finishing.';

export function decideStopHook(input: StopHookDecision): StopHookResult {
  if (input.markerExists || input.stopHookActive) {
    return { allow: true };
  }
  return { decision: 'block', reason: BLOCK_REASON };
}

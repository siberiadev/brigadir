/**
 * Pure PreToolUse bash-guard decision (contracts/stop-hook-settings.md,
 * «Bash-guard hook behavior»). Extracted from bash-guard.ts so the heuristic
 * is unit-testable without spawning a process or touching real stdin.
 *
 * Why this exists: token-spend analysis 2026-07-28 (problem 1) — 621 in-session
 * `sleep`-polling turns across 176 runs; every polling turn re-reads the whole
 * multi-million-token cached context. Waiting must end the session (the
 * platform restarts the run when the condition holds), never busy-wait in it.
 */

/**
 * Stable machine-recognizable prefix of every deny reason. The stream parser
 * (libs/executors/src/claude-cli/stream-parser.ts) matches this literal in
 * tool_result blocks to emit `tool_denied` run events — keep both in sync
 * (no cross-package import; both spec suites pin the literal).
 */
export const BASH_GUARD_PREFIX = '[brigadir-bash-guard]';

/** Cumulative sleep seconds allowed per command (short cushioning sleeps pass). */
export const MAX_SLEEP_SECONDS = 15;

export type BashGuardVerdict =
  | { allow: true }
  | { deny: true; rule: 'loop_sleep' | 'cumulative_sleep' | 'unparsable_sleep'; reason: string };

const GUIDANCE =
  'In-session waiting is forbidden — never sleep/poll for a precondition (CI, a deploy, ' +
  'another ticket, a human answer, infrastructure recovery). If you are blocked on something ' +
  'outside this session, end the session instead: call ' +
  'mcp__brigadir__request_human(blocking=true, ...) when a person must act, or ' +
  'mcp__brigadir__complete_task(outcome="failure" or "needs_human") describing exactly what ' +
  'you are waiting for. The platform restarts the run when the condition holds.';

/**
 * `sleep` as a command word: start of string or after a shell separator (a
 * directly-preceding quote is deliberately NOT a separator, so `grep "sleep
 * 600"` passes). The argument capture stops at separators so `sleep 10; …`
 * yields `10`, not `10;`.
 */
const SLEEP_OCCURRENCE = /(?:^|[;&|(`{\s])sleep\s+([^\s;&|()`]+)/g;

/** GNU sleep duration: number with optional s/m/h/d suffix. */
const SLEEP_DURATION = /^([0-9]*\.?[0-9]+)(s|m|h|d)?$/;

/**
 * Loop detection requires BOTH a loop keyword in command position AND `done` —
 * prose like `git commit -m "wait for review"` has neither, and every real
 * one-liner shell loop closes with `done`.
 */
const LOOP_KEYWORD = /(?:^|[;&|({`\s])(?:while|until|for)\s/;

const SUFFIX_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function deny(rule: 'loop_sleep' | 'cumulative_sleep' | 'unparsable_sleep', detail: string): BashGuardVerdict {
  return { deny: true, rule, reason: `${BASH_GUARD_PREFIX} Denied: ${detail}. ${GUIDANCE}` };
}

/**
 * Heuristic over the raw command string (no shell parsing, v1): allow commands
 * without sleep; deny sleep inside a loop regardless of duration; deny sleep
 * with an unparsable (dynamic) duration; deny cumulative sleep over the cap.
 * Known accepted false positive: a space-preceded `sleep <n>` inside quoted
 * prose (e.g. `echo "will sleep 600"`) is treated as a real sleep — pinned in
 * the spec as the v1 cost.
 */
export function analyzeBashCommand(command: string): BashGuardVerdict {
  const sleepArgs = [...command.matchAll(SLEEP_OCCURRENCE)].map((m) => m[1]);
  if (sleepArgs.length === 0) return { allow: true };

  if (LOOP_KEYWORD.test(command) && /\bdone\b/.test(command)) {
    return deny('loop_sleep', 'sleep inside a while/until/for loop');
  }

  let totalSeconds = 0;
  for (const arg of sleepArgs) {
    const parsed = SLEEP_DURATION.exec(arg);
    if (!parsed) {
      return deny('unparsable_sleep', 'sleep with an unbounded/dynamic duration');
    }
    totalSeconds += Number(parsed[1]) * SUFFIX_SECONDS[parsed[2] ?? 's'];
  }

  if (totalSeconds > MAX_SLEEP_SECONDS) {
    return deny(
      'cumulative_sleep',
      `cumulative sleep of ${totalSeconds}s exceeds the ${MAX_SLEEP_SECONDS}s limit`,
    );
  }

  return { allow: true };
}

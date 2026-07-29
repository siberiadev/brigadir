#!/usr/bin/env node
import { analyzeBashCommand } from './bash-guard-logic.js';

/**
 * PreToolUse bash-guard hook (contracts/stop-hook-settings.md, «Bash-guard
 * hook behavior»). Invoked by the CLI as `node bash-guard.js` (stateless, no
 * argv) with the hook-event JSON on stdin. Denies sleep-dominant Bash commands
 * so agents end the session instead of busy-waiting (token-spend analysis
 * 2026-07-28, problem 1). Best-effort only — every path exits 0 (fail-open);
 * run correctness never depends on this hook firing.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function extractCommand(raw: string): string | undefined {
  try {
    const input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (input.tool_name !== 'Bash') return undefined;
    const toolInput = input.tool_input;
    if (typeof toolInput !== 'object' || toolInput === null) return undefined;
    const command = (toolInput as Record<string, unknown>).command;
    return typeof command === 'string' ? command : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const command = extractCommand(await readStdin());

  if (command !== undefined) {
    const verdict = analyzeBashCommand(command);
    if ('deny' in verdict) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason,
          },
        }),
      );
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`brigadir bash-guard: fatal: ${String(err)}`);
  process.exit(0);
});

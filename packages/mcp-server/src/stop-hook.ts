#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { decideStopHook } from './stop-hook-logic.js';

/**
 * Stop hook (contracts/stop-hook-settings.md). Invoked by the CLI as
 * `node stop-hook.js <markerPath>` with the hook-event JSON on stdin.
 * Best-effort UX only — FR-010 fail-closed is the real guarantee if this
 * never fires or errors out.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const markerPath = process.argv[2];
  const raw = await readStdin();

  let stopHookActive: boolean;
  try {
    const input = raw ? (JSON.parse(raw) as { stop_hook_active?: unknown }) : {};
    stopHookActive = input.stop_hook_active === true;
  } catch {
    stopHookActive = false;
  }

  const markerExists = markerPath ? existsSync(markerPath) : false;
  const result = decideStopHook({ markerExists, stopHookActive });

  if ('decision' in result) {
    process.stdout.write(JSON.stringify({ decision: result.decision, reason: result.reason }));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`brigadir stop-hook: fatal: ${String(err)}`);
  process.exit(0);
});

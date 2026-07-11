#!/usr/bin/env node
// Substitutable `claude` binary for integration tests (research D8,
// contracts/cli-io.md). Streams a recorded ndjson fixture to stdout
// line-by-line, dumps its received env/argv for the security test (T085),
// and can spawn a sleeping grandchild for the process-group-kill test
// (T086). No real `claude` binary or network access — never spawned outside
// test/integration.
//
// Control channel: env vars only (never argv — argv must stay a faithful
// copy of what the real executor would pass a real `claude` binary, so the
// argv-dump file used by T085 proves ticket/secret text never leaks there).
//
//   FAKE_CLAUDE_FIXTURE        - fixture name (no .ndjson) to stream to stdout
//   FAKE_CLAUDE_ENV_DUMP       - path to write a JSON dump of process.env
//   FAKE_CLAUDE_ARGV_DUMP      - path to write a JSON dump of process.argv.slice(2)
//   FAKE_CLAUDE_SPAWN_CHILD    - '1' => spawn a sleeping grandchild, then hang
//   FAKE_CLAUDE_CHILD_PID_FILE - path to write the spawned grandchild's pid
//   FAKE_CLAUDE_SELF_PID_FILE  - path to write this script's own pid (SC-004 orphan check)
//   FAKE_CLAUDE_STDERR_TEXT    - text to write to stderr before exiting
//   FAKE_CLAUDE_EXIT_CODE      - process exit code (default 0)
//   FAKE_CLAUDE_LINE_DELAY_MS  - delay between stdout lines (default 20)

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureName = process.env.FAKE_CLAUDE_FIXTURE;
const envDumpPath = process.env.FAKE_CLAUDE_ENV_DUMP;
const argvDumpPath = process.env.FAKE_CLAUDE_ARGV_DUMP;
const spawnChild = process.env.FAKE_CLAUDE_SPAWN_CHILD === '1';
const childPidFile = process.env.FAKE_CLAUDE_CHILD_PID_FILE;
const selfPidFile = process.env.FAKE_CLAUDE_SELF_PID_FILE;
const stderrText = process.env.FAKE_CLAUDE_STDERR_TEXT;
const exitCode = process.env.FAKE_CLAUDE_EXIT_CODE ? Number(process.env.FAKE_CLAUDE_EXIT_CODE) : 0;
const lineDelayMs = process.env.FAKE_CLAUDE_LINE_DELAY_MS
  ? Number(process.env.FAKE_CLAUDE_LINE_DELAY_MS)
  : 20;

// Honor SIGTERM promptly (D2): print nothing further, exit. SIGKILL is the
// OS default (no handler needed/possible).
process.on('SIGTERM', () => {
  process.exit(0);
});

// Dumped unconditionally and first, so a mid-run SIGTERM/SIGKILL still leaves
// the security-test evidence on disk.
if (argvDumpPath) {
  writeFileSync(argvDumpPath, JSON.stringify(process.argv.slice(2)));
}
if (envDumpPath) {
  writeFileSync(envDumpPath, JSON.stringify(process.env));
}
if (selfPidFile) {
  writeFileSync(selfPidFile, String(process.pid));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (spawnChild) {
    // Spawned WITHOUT its own `detached`, so it stays in the same process
    // group as this script (the group leader, per D2) — a group-wide
    // SIGTERM/SIGKILL reaches it too. This models `claude`'s own Bash-tool
    // grandchildren.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    if (childPidFile) writeFileSync(childPidFile, String(child.pid));
    // Deliberately NOT unref()'d: a pending `await new Promise(() => {})` does
    // NOT by itself keep Node's event loop alive (it's a microtask-level
    // construct, not a libuv handle) — without a ref'd handle, the process
    // would exit almost immediately despite never resolving. The still-ref'd
    // child (plus its own `setInterval`) is what actually makes this hang
    // until killed, simulating a stuck/long-running turn.
    await new Promise(() => {});
    return;
  }

  if (fixtureName) {
    const fixturePath = join(__dirname, `${fixtureName}.ndjson`);
    const rl = createInterface({ input: createReadStream(fixturePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      process.stdout.write(line + '\n');
      await sleep(lineDelayMs);
    }
  }

  if (stderrText) {
    process.stderr.write(stderrText);
  }

  process.exit(exitCode);
}

main();

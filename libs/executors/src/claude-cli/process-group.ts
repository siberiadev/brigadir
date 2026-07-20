import { spawn, execFile, type ChildProcess } from 'node:child_process';

export interface SpawnGroupOptions {
  cwd: string;
  env: Record<string, string>;
}

export interface ProcessGroup {
  readonly child: ChildProcess;
  /** Signal the whole process group (negative pid). ESRCH (already gone) is swallowed. */
  killGroup(signal: NodeJS.Signals): void;
  /** SIGTERM now; SIGKILL after `killGraceMs` if still alive. Safe to call more than once. */
  terminate(killGraceMs: number): Promise<void>;
}

/**
 * Spawn `cliPath` as a process-group leader (research D2). `detached: true`
 * makes the child's pid its own group id, so `killGroup` reaches every
 * descendant it spawns (git, pnpm, test runners) via the negative-pid
 * signal — not just the direct child. Never `shell:true` (breaks group
 * semantics and reintroduces a shell-injection surface). `unref()` is never
 * called: the caller always awaits the child's `exit` event to finalize.
 */
export function spawnGroup(cliPath: string, argv: string[], options: SpawnGroupOptions): ProcessGroup {
  const child = spawn(cliPath, argv, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  function killGroup(signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }

  async function terminate(killGraceMs: number): Promise<void> {
    killGroup('SIGTERM');
    const exited = await waitForExit(child, killGraceMs);
    if (exited) return;

    // Still alive after the grace window. A grandchild that called setsid()
    // (docker, some daemonized helpers) started its OWN process group, so the
    // negative-pid SIGTERM never reached it — it survives, keeps the leader's
    // stdout/stderr pipe fds open, and the leader's 'close' never fires, pinning
    // the worker slot until the run timeout (incident 2026-07-19). Snapshot the
    // descendant tree WHILE the leader is still alive (a SIGKILLed leader's
    // children reparent to init and lose the ppid link), then SIGKILL the group
    // AND every escaped descendant by pid.
    let descendants: number[] = [];
    if (child.pid !== undefined) {
      try {
        descendants = await collectDescendants(child.pid);
      } catch (err) {
        process.stderr.write(`[process-group] descendant snapshot failed: ${String(err)}\n`);
      }
    }

    killGroup('SIGKILL');
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          process.stderr.write(`[process-group] SIGKILL ${pid} failed: ${String(err)}\n`);
        }
      }
    }
    if (descendants.length > 0) {
      process.stderr.write(
        `[process-group] SIGKILL group ${child.pid} + reaped ${descendants.length} escaped descendant(s): ${descendants.join(',')}\n`,
      );
    }
  }

  return { child, killGroup, terminate };
}

/**
 * Direct children of `pid` via `pgrep -P`. Best-effort: `pgrep` exits 1 with no
 * output when there are no matches (not an error for us), and any failure to
 * spawn it (binary missing, permission) resolves to `[]` so termination falls
 * back to the process-group signal alone — never throws into the executor.
 */
function pgrepChildren(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    try {
      execFile('pgrep', ['-P', String(pid)], (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((n) => Number.isInteger(n) && n > 0),
        );
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * Breadth-first walk of the whole descendant tree rooted at `rootPid`
 * (exclusive of the root itself, which the group signal already covers).
 */
async function collectDescendants(rootPid: number): Promise<number[]> {
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    const children = await pgrepChildren(pid);
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return [...seen];
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

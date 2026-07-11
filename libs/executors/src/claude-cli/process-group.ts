import { spawn, type ChildProcess } from 'node:child_process';

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
    if (!exited) {
      killGroup('SIGKILL');
    }
  }

  return { child, killGroup, terminate };
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

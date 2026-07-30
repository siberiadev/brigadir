import { spawn } from 'node:child_process';

import { statusPorcelain, revertTracked, type WorktreeDirtyState } from './worktree';

/**
 * Feature 035: platform-run repository bootstrap (token-spend analysis
 * 2026-07-28, §4/§5). Two jobs, both executed in the prepare phase so the
 * agent finds a ready environment instead of paying for it in prompt turns:
 *
 *  - run the repository's operator-configured `bootstrap_command` (typically
 *    `npm ci`) inside the fresh worktree, against a shared package-manager
 *    cache;
 *  - the dirty-guard: assert the tree is clean afterwards (and, independently
 *    of any bootstrap, after plain prepare) — revert tracked modifications and
 *    report, instead of leaking the mystery to every agent that mounts the
 *    repo (the st3_agentic two-spec-files defect: 25 paid rediscoveries).
 *
 * Kept out of claude-cli.executor.ts so the executor spec can mock it exactly
 * like `prepareAll`, and this module's spec can use real processes and real
 * temp git repos without the executor harness.
 */

/** Rolling output tail kept per stream — enough to diagnose, never a dump. */
export const BOOTSTRAP_TAIL_BYTES = 4096;

export interface BootstrapExecInput {
  worktreeDir: string;
  /** The operator's command line, run via `/bin/sh -c`. */
  command: string;
  /**
   * Fully assembled child env (allowlist floor + operator env + the shared
   * npm cache override). Never the worker's raw process.env.
   */
  env: Record<string, string>;
  /** Hang-breaker (already clamped by normalizeBootstrapTimeoutMs). */
  timeoutMs: number;
  /** The run's abort signal — a cancelled/timed-out run stops installing. */
  signal?: AbortSignal;
}

export interface BootstrapExecResult {
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /** The hang-breaker fired (group SIGKILLed). */
  timedOut: boolean;
  /** The run's own signal aborted the command mid-flight. */
  aborted: boolean;
}

class RollingTail {
  private buf = '';

  push(chunk: Buffer | string): void {
    this.buf += chunk.toString();
    if (this.buf.length > BOOTSTRAP_TAIL_BYTES) {
      this.buf = this.buf.slice(this.buf.length - BOOTSTRAP_TAIL_BYTES);
    }
  }

  get text(): string {
    return this.buf;
  }
}

/**
 * Run one bootstrap command in a worktree. Deliberately `spawn` with
 * `detached: true` + negative-pid kill, NOT `execFile` with `timeout`:
 * execFile's timeout SIGTERMs only the `sh` leader, so npm's descendants
 * (node-gyp, postinstall scripts) escape and keep running — the exact wedge
 * feature 034 closed for the agent child. `/bin/sh -c` (not `-lc`): the env
 * must be byte-identical to what the agent child gets, and a login shell's
 * profile could rewrite PATH out from under that parity.
 *
 * Never throws for command outcomes — timeout/abort/non-zero exit all come
 * back as a structured result; the CALLER owns the failure policy. Only a
 * spawn-level fault (sh missing) rejects.
 */
export function runBootstrap(input: BootstrapExecInput): Promise<BootstrapExecResult> {
  const startedAt = Date.now();
  const child = spawn('/bin/sh', ['-c', input.command], {
    cwd: input.worktreeDir,
    env: input.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutTail = new RollingTail();
  const stderrTail = new RollingTail();
  child.stdout?.on('data', (c: Buffer) => stdoutTail.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrTail.push(c));

  const killGroup = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  };

  return new Promise<BootstrapExecResult>((resolve, reject) => {
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, input.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killGroup('SIGKILL');
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (err) => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    // 'close' (not 'exit'): both stdio pipes are drained, so the tails are
    // complete. The group is SIGKILLed on timeout/abort — a descendant holding
    // the pipes open past that is possible but bounded by the SIGKILL of the
    // whole group; unlike the agent child there is no settle window because
    // nothing here parses a partial outcome.
    child.once('close', (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stdoutTail: stdoutTail.text,
        stderrTail: stderrTail.text,
        timedOut,
        aborted,
      });
    });
  });
}

export interface DirtyGuardResult {
  /** What the first status pass found. Both empty ⇒ nothing was done. */
  found: WorktreeDirtyState;
  /** Tracked paths that were reverted (equals `found.modified` when any). */
  reverted: string[];
  /** What a SECOND status pass still sees after the revert — honest residue. */
  residual: WorktreeDirtyState;
}

/**
 * The post-prepare cleanliness assertion (feature 035, dirty-guard). Runs for
 * EVERY prepared worktree — with or without a bootstrap command — because the
 * defect it neutralizes (a repo whose routine operations dirty tracked files)
 * predates any bootstrap. Tracked modifications are reverted so the agent
 * starts from exactly the start ref; untracked files stay (bootstrap output
 * like node_modules is usually gitignored, and what isn't may still be
 * wanted) and are only reported.
 */
export async function dirtyGuard(worktreeDir: string): Promise<DirtyGuardResult> {
  const found = await statusPorcelain(worktreeDir);
  if (found.modified.length === 0) {
    return { found, reverted: [], residual: found };
  }
  await revertTracked(worktreeDir);
  const residual = await statusPorcelain(worktreeDir);
  return { found, reverted: found.modified, residual };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/** A git operation failed (non-zero exit, timeout, or spawn error). */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitExecOptions {
  cwd?: string;
  /** Extra env merged over process.env for the child ONLY (e.g. ephemeral auth). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Run `git` via execFile (no shell → no injection) and return stdout. Shares the
 * exec approach of libs/executors worktree.ts, but generic and auth-aware: the
 * `env` is applied to the CHILD process only and never appears in argv, so a
 * token passed via GIT_CONFIG_* (see git-auth.ts) stays out of `ps`.
 */
export async function execGit(args: string[], opts: GitExecOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // Never echo the child env (it may carry the auth header) — only argv + stderr.
    const e = err as { stderr?: string; message?: string };
    throw new GitError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message ?? 'unknown error').trim()}`);
  }
}

async function isHealthyRepo(dir: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--git-dir'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the committish to check out: `origin/<ref>` (branch) → `<ref>` (tag/sha) → default. */
async function resolveCommittish(cacheDir: string, ref: string | undefined, timeoutMs?: number): Promise<string> {
  const verify = async (rev: string): Promise<boolean> => {
    try {
      await execGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: cacheDir, timeoutMs });
      return true;
    } catch {
      return false;
    }
  };
  if (!ref) {
    // Default branch tip: origin/HEAD → e.g. "origin/main"; fall back to FETCH_HEAD.
    try {
      const head = (await execGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: cacheDir, timeoutMs })).trim();
      if (head) return head;
    } catch {
      /* fall through */
    }
    return 'FETCH_HEAD';
  }
  if (await verify(`origin/${ref}`)) return `origin/${ref}`;
  if (await verify(ref)) return ref;
  throw new GitError(`ref "${ref}" not found in the template repository`);
}

/**
 * Ensure a fresh cached checkout of `url` at `ref` in `cacheDir`, returning the
 * checkout directory. Self-healing: a corrupt cache is discarded and re-cloned.
 * The whole repo is small (a role-template repo), so re-cloning on any doubt is
 * cheap and simpler than the incident-hardened worktree cache — which stays as
 * its own specialized layer (this util is deliberately not wired into it).
 */
export async function ensureCachedClone(params: {
  url: string;
  cacheDir: string;
  ref?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<string> {
  const { url, cacheDir, ref, env, timeoutMs } = params;

  if (existsSync(cacheDir) && !(await isHealthyRepo(cacheDir))) {
    await rm(cacheDir, { recursive: true, force: true });
  }

  if (existsSync(cacheDir)) {
    try {
      await execGit(['fetch', '--prune', 'origin'], { cwd: cacheDir, env, timeoutMs });
    } catch {
      await rm(cacheDir, { recursive: true, force: true });
      await execGit(['clone', url, cacheDir], { env, timeoutMs });
    }
  } else {
    await execGit(['clone', url, cacheDir], { env, timeoutMs });
  }

  const committish = await resolveCommittish(cacheDir, ref, timeoutMs);
  await execGit(['checkout', '--detach', committish], { cwd: cacheDir, timeoutMs });
  return cacheDir;
}

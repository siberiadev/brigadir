import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface WorktreeRepo {
  name: string;
  url: string;
  defaultBranch: string;
}

export interface PrepareResult {
  worktreeDir: string;
  branch: string;
  cacheDir: string;
}

export class WorktreePrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePrepareError';
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new WorktreePrepareError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

/**
 * Prepare a per-run git worktree (research D3). Keeps one cached local clone
 * per repository (`repoCacheRoot/<repo.name>`) and adds a fresh worktree off
 * `origin/<repo.defaultBranch>` per run, on branch `<branchPrefix>/<ticketKey>`.
 * Fails fast and loud — never silently reuses or force-resets — if that
 * branch already exists (a prior crashed run's leftover), per the spec edge
 * case: running against a stale/half-finished tree is worse than failing.
 */
export async function prepare(
  repo: WorktreeRepo,
  runId: string,
  ticketKey: string,
  branchPrefix: string,
  worktreeRoot: string,
  repoCacheRoot: string,
): Promise<PrepareResult> {
  await mkdir(repoCacheRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  const cacheDir = join(repoCacheRoot, repo.name);
  if (existsSync(join(cacheDir, '.git'))) {
    await git(['fetch', 'origin'], cacheDir);
  } else {
    await git(['clone', repo.url, cacheDir]);
  }

  await git(['worktree', 'prune'], cacheDir);

  const branch = `${branchPrefix}/${ticketKey}`;
  const worktreeDir = join(worktreeRoot, runId);
  const baseRef = `origin/${repo.defaultBranch}`;

  try {
    await git(['worktree', 'add', '-b', branch, worktreeDir, baseRef], cacheDir);
  } catch (err) {
    throw new WorktreePrepareError(
      `cannot create worktree on branch "${branch}" — it likely already exists from a prior run ` +
        `(no silent reuse/force-reset): ${(err as Error).message}`,
    );
  }

  return { worktreeDir, branch, cacheDir };
}

/**
 * Remove the per-run worktree. `--force` is required because the tree may
 * have uncommitted/dirty files; it removes the working tree and its
 * administrative entry but does NOT delete the branch (pushed work is
 * preserved). Skipped entirely when `keep` is set (debugging a failed run).
 */
export async function cleanup(
  cacheDir: string,
  worktreeDir: string,
  opts: { keep?: boolean } = {},
): Promise<void> {
  if (opts.keep) return;
  await git(['worktree', 'remove', '--force', worktreeDir], cacheDir);
}

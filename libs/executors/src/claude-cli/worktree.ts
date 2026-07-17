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

/**
 * Branch identity of a TICKETLESS workspace-setup run (feature 015, FR-020):
 * `setup/<first 8 chars of run id>`. Deterministic and collision-free (run ids
 * are unique; every resume creates a NEW setup run per feature 011), and
 * local-only — a setup run never pushes (spec FR-015); cleanup removes the
 * worktree like any run, and a leftover zero-commit branch falls under the
 * standard leftover policy in prepare().
 */
export function setupRunBranchIdentity(runId: string): { branchPrefix: string; ticketKey: string } {
  return { branchPrefix: 'setup', ticketKey: runId.slice(0, 8) };
}

async function branchExists(cacheDir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: cacheDir,
    });
    return true;
  } catch {
    return false;
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
 * Leftover-branch policy (revised, live incident 2026-07-14): an existing
 * branch with ZERO commits beyond the base ref is a worthless remnant of an
 * attempt that died before doing work — it is deleted and recreated so
 * retries are possible. An existing branch WITH commits is real prior work —
 * fail fast and loud (never silently reuse or force-reset); a human decides.
 */
export async function prepare(
  repo: WorktreeRepo,
  runId: string,
  ticketKey: string,
  branchPrefix: string,
  worktreeRoot: string,
  repoCacheRoot: string,
  opts: { reuseBranch?: boolean } = {},
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
    if (opts.reuseBranch) {
      // Feature 004 (FR-016/018): a resumed attempt deliberately CONTINUES
      // the same ticket branch a prior attempt started — attach a worktree
      // to the existing branch rather than creating a fresh one.
      await git(['worktree', 'add', worktreeDir, branch], cacheDir);
    } else {
      // Live incident 2026-07-14: a failed attempt leaves its branch behind
      // (cleanup removes the worktree, never the branch), so EVERY retry of a
      // failed run collided here and failure became permanent. Distinguish the
      // two leftover cases instead of failing on both:
      //  - branch exists with ZERO commits beyond the base ref → worthless
      //    leftover of an attempt that died before doing work; delete and
      //    recreate fresh (deterministic, nothing lost).
      //  - branch exists WITH commits → real prior work; keep failing loud
      //    (no silent reuse/force-reset — a human decides).
      const exists = await branchExists(cacheDir, branch);
      if (exists) {
        const ahead = (await git(['rev-list', '--count', `${baseRef}..${branch}`], cacheDir)).trim();
        if (ahead === '0') {
          await git(['branch', '-D', branch], cacheDir);
        } else {
          throw new WorktreePrepareError(
            `branch "${branch}" already exists with ${ahead} commit(s) of prior work — ` +
              `refusing to discard or silently reuse it; delete or merge the branch, then retry`,
          );
        }
      }
      await git(['worktree', 'add', '-b', branch, worktreeDir, baseRef], cacheDir);
    }
  } catch (err) {
    if (err instanceof WorktreePrepareError) throw err;
    throw new WorktreePrepareError(
      `cannot create worktree on branch "${branch}": ${(err as Error).message}`,
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

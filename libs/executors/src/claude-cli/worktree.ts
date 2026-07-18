import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface WorktreeRepo {
  name: string;
  url: string;
  defaultBranch: string;
}

/** One prepared per-repo worktree inside a run's parent workspace dir. */
export interface RepoWorktree {
  repo: WorktreeRepo;
  worktreeDir: string;
  cacheDir: string;
}

/**
 * A run's whole prepared workspace (feature 019): the parent dir the agent
 * works in (`worktreeRoot/<runId>`), containing one worktree per repo — all
 * on the SAME branch (branch↔ticket traceability across repos).
 */
export interface MultiPrepareResult {
  parentDir: string;
  branch: string;
  repos: RepoWorktree[];
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
 * standard leftover policy in prepareAll().
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

/** Does `cacheDir` hold a repository git itself will accept? */
async function isHealthyRepo(cacheDir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: cacheDir });
    return true;
  } catch {
    return false;
  }
}

/** Can HEAD still be resolved to an object? Cheap probe for a gutted object store. */
async function headResolves(cacheDir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['cat-file', '-e', 'HEAD'], { cwd: cacheDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * One cached local clone per repository (`repoCacheRoot/<repo.name>`), refreshed
 * per run — self-healing since the live incident of 2026-07-18.
 *
 * The cache OUTLIVES a run, so anything may rot it between runs. macOS reaps
 * files (not directories) older than ~3 days out of `$TMPDIR`, which leaves a
 * skeleton: `.git/` present, `HEAD` and the refs gone. The old check asked
 * `existsSync('.git')` — "has this been cloned?" — took the fetch branch and
 * died with `fatal: not a git repository` on EVERY retry, permanently, because
 * nothing ever reconsidered cloning. ST3-780 burned 5 attempts that way.
 *
 * So the question asked is "does git accept this?", not "does the path exist?",
 * and a rotten cache is discarded and re-cloned. A fetch FAILURE is deliberately
 * NOT treated as rot: it is usually the network or SSH auth, where nuking a good
 * cache costs a full re-clone and fixes nothing (the clone needs the same
 * network). Only when HEAD no longer resolves — a partially reaped object store,
 * the same rot arriving by another route — do we discard and re-clone; otherwise
 * the error propagates for the operator to see.
 */
async function ensureCache(repo: WorktreeRepo, repoCacheRoot: string): Promise<string> {
  const cacheDir = join(repoCacheRoot, repo.name);
  if (existsSync(cacheDir) && !(await isHealthyRepo(cacheDir))) {
    await rm(cacheDir, { recursive: true, force: true });
  }

  if (existsSync(cacheDir)) {
    try {
      await git(['fetch', 'origin'], cacheDir);
    } catch (err) {
      if (await headResolves(cacheDir)) throw err;
      await rm(cacheDir, { recursive: true, force: true });
      await git(['clone', repo.url, cacheDir]);
    }
  } else {
    await git(['clone', repo.url, cacheDir]);
  }

  await git(['worktree', 'prune'], cacheDir);
  return cacheDir;
}

/**
 * Add one repo's worktree on `branch` into `worktreeDir` (research D3 layout).
 * Leftover-branch policy (revised, live incident 2026-07-14) — applied PER
 * REPO, unchanged by feature 019: an existing branch with ZERO commits beyond
 * the base ref is a worthless remnant of an attempt that died before doing
 * work — it is deleted and recreated so retries are possible. An existing
 * branch WITH commits is real prior work — fail fast and loud (never silently
 * reuse or force-reset); a human decides.
 *
 * `reuseBranch` (feature 004 FR-016/018): a resumed attempt deliberately
 * CONTINUES the ticket branch a prior attempt started — attach where the
 * branch exists. Feature 019 (research D4): if the branch does NOT exist in
 * some repo (agent scope widened between attempts, or the first attempt never
 * branched there), fall through to fresh creation instead of failing — a
 * resume is a continuation, not a stale-leftover hazard.
 */
async function addRepoWorktree(
  repo: WorktreeRepo,
  cacheDir: string,
  worktreeDir: string,
  branch: string,
  opts: { reuseBranch?: boolean },
): Promise<void> {
  const baseRef = `origin/${repo.defaultBranch}`;
  try {
    const exists = await branchExists(cacheDir, branch);
    if (opts.reuseBranch && exists) {
      await git(['worktree', 'add', worktreeDir, branch], cacheDir);
      return;
    }
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
  } catch (err) {
    if (err instanceof WorktreePrepareError) throw err;
    throw new WorktreePrepareError(
      `cannot create worktree on branch "${branch}": ${(err as Error).message}`,
    );
  }
}

/**
 * Prepare a run's workspace (feature 019, research D3/D4): one worktree per
 * repo under `worktreeRoot/<runId>/<repo.name>/`, every repo on the same
 * `<branchPrefix>/<ticketKey>` branch off `origin/<repo.defaultBranch>`.
 * Sequential by design — repo counts are small and error attribution stays
 * deterministic. ALL-OR-NOTHING: a failure at repo N unwinds the N-1
 * worktrees already created and removes the parent dir (spec FR-008/SC-006),
 * then rethrows naming the failing repo.
 */
export async function prepareAll(
  repos: WorktreeRepo[],
  runId: string,
  ticketKey: string,
  branchPrefix: string,
  worktreeRoot: string,
  repoCacheRoot: string,
  opts: { reuseBranch?: boolean } = {},
): Promise<MultiPrepareResult> {
  if (repos.length === 0) {
    throw new WorktreePrepareError('no repositories to prepare for this run');
  }
  await mkdir(repoCacheRoot, { recursive: true });
  const parentDir = join(worktreeRoot, runId);
  await mkdir(parentDir, { recursive: true });

  const branch = `${branchPrefix}/${ticketKey}`;
  const prepared: RepoWorktree[] = [];
  for (const repo of repos) {
    try {
      const cacheDir = await ensureCache(repo, repoCacheRoot);
      const worktreeDir = join(parentDir, repo.name);
      await addRepoWorktree(repo, cacheDir, worktreeDir, branch, opts);
      prepared.push({ repo, worktreeDir, cacheDir });
    } catch (err) {
      // Unwind everything this run already created — no orphaned half-prepared
      // workspaces (best-effort per worktree; `git worktree prune` on the next
      // run's ensureCache reclaims any stale admin entry).
      for (const p of prepared) {
        await git(['worktree', 'remove', '--force', p.worktreeDir], p.cacheDir).catch(() => {});
      }
      await rm(parentDir, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      throw new WorktreePrepareError(`repo "${repo.name}": ${message}`);
    }
  }

  return { parentDir, branch, repos: prepared };
}

/**
 * Remove the run's whole workspace: every per-repo worktree (`--force` — the
 * trees may be dirty; branches are NOT deleted, pushed/committed work is
 * preserved) and then the parent dir (which also carries `.brigadir/`).
 * Skipped entirely when `keep` is set (debugging a failed run keeps the whole
 * parent for inspection). Worktree-removal faults are remembered but do not
 * stop the loop or the parent removal — the first one is rethrown at the end
 * so the caller can log it; a stale cache admin entry is reclaimed by the
 * next run's `git worktree prune`.
 */
export async function cleanupAll(
  workspace: { parentDir: string; repos: Pick<RepoWorktree, 'cacheDir' | 'worktreeDir'>[] },
  opts: { keep?: boolean } = {},
): Promise<void> {
  if (opts.keep) return;
  let firstError: unknown;
  for (const p of workspace.repos) {
    try {
      await git(['worktree', 'remove', '--force', p.worktreeDir], p.cacheDir);
    } catch (err) {
      firstError ??= err;
    }
  }
  await rm(workspace.parentDir, { recursive: true, force: true });
  if (firstError !== undefined) throw firstError;
}

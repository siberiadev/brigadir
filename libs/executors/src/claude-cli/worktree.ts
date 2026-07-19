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

/**
 * Where one repo's worktree was parked, and why (feature 023). The worktree is
 * always DETACHED: the system no longer owns the branch namespace — the agent
 * creates and pushes its own branch.
 */
export interface RepoStart {
  /** The commit-ish the worktree is detached at. */
  startRef: string;
  /**
   * Branch a previous stage on this ticket reported, verified present on
   * origin. Absent ⇒ this repo starts from its default branch.
   */
  continueBranch?: string;
}

/** One prepared per-repo worktree inside a run's parent workspace dir. */
export interface RepoWorktree {
  repo: WorktreeRepo;
  worktreeDir: string;
  cacheDir: string;
  start: RepoStart;
}

/**
 * A run's whole prepared workspace (feature 019): the parent dir the agent
 * works in (`worktreeRoot/<runId>`), containing one worktree per repo.
 *
 * There is deliberately NO run-level branch (feature 023 removed it): repo A
 * may continue a previous stage's branch while repo B starts fresh from its
 * default branch, so a single shared name would be a structural lie. Per-repo
 * provenance lives in `RepoWorktree.start`.
 */
export interface MultiPrepareResult {
  parentDir: string;
  repos: RepoWorktree[];
}

export class WorktreePrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePrepareError';
  }
}

/**
 * Is `branch` present on the remote? Checked against `refs/remotes/origin/*`,
 * never `refs/heads/*`: a local head in the shared cache may be an inert
 * leftover from a pre-023 run and proves nothing about what a previous stage
 * actually pushed. Correctness depends on `ensureCache` fetching with
 * `--prune` — without it a deleted branch lingers here forever.
 */
async function remoteBranchExists(cacheDir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      { cwd: cacheDir },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * A branch name from an agent report is untrusted free text (`ReportSchema`
 * only bounds its length) that lands in an argv position. There is no shell
 * (`execFile`), so no injection — but a leading `-` would be parsed as an
 * OPTION by git (`--upload-pack=…`), so it is rejected before anything else,
 * then git itself judges the grammar.
 */
async function assertSafeBranchName(branch: string): Promise<void> {
  if (branch.length === 0 || branch.startsWith('-')) {
    throw new WorktreePrepareError(`reported branch name "${branch}" is not a valid branch name`);
  }
  try {
    await execFileAsync('git', ['check-ref-format', '--branch', branch]);
  } catch {
    throw new WorktreePrepareError(`reported branch name "${branch}" is not a valid branch name`);
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
      // `--prune` is load-bearing since feature 023, not hygiene: start refs are
      // resolved against `refs/remotes/origin/*`, and without pruning a branch
      // deleted upstream lingers here forever — a run would silently start from
      // a deleted branch's stale tip, with no error anywhere. Do not drop it.
      await git(['fetch', '--prune', 'origin'], cacheDir);
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
 * Add one repo's DETACHED worktree into `worktreeDir` (research D3 layout,
 * revised by feature 023).
 *
 * The system no longer creates, deletes or resets branches — it only chooses
 * the commit to start from. That retires the leftover-branch policy born of
 * the 2026-07-14 incident: there is no longer a system-chosen branch name for
 * a later run to collide with, and no code path that CAN discard prior work
 * (`git branch -D` left the codebase entirely). Naming and pushing are the
 * agent's job; the wrapper tells it what to create or continue.
 *
 * `continueBranch` is a branch a previous stage on this ticket reported. It is
 * agent-authored, so it is validated, then verified to exist on origin. The
 * asymmetry is deliberate and load-bearing: a branch EXPLICITLY named but
 * missing fails loudly, while NO named branch quietly means "start from the
 * default". Falling back to the default on an explicit miss would let a
 * reviewer silently review an empty diff and report success.
 */
async function addRepoWorktree(
  repo: WorktreeRepo,
  cacheDir: string,
  worktreeDir: string,
  continueBranch: string | undefined,
): Promise<RepoStart> {
  let start: RepoStart = { startRef: `origin/${repo.defaultBranch}` };
  if (continueBranch !== undefined) {
    await assertSafeBranchName(continueBranch);
    if (!(await remoteBranchExists(cacheDir, continueBranch))) {
      throw new WorktreePrepareError(
        `previous run reported branch "${continueBranch}" but origin has no such branch — ` +
          `push it or clear the stale report, then retry`,
      );
    }
    start = { startRef: `origin/${continueBranch}`, continueBranch };
  }
  try {
    await git(['worktree', 'add', '--detach', worktreeDir, start.startRef], cacheDir);
  } catch (err) {
    if (err instanceof WorktreePrepareError) throw err;
    throw new WorktreePrepareError(
      `cannot create worktree at "${start.startRef}": ${(err as Error).message}`,
    );
  }
  return start;
}

/**
 * Prepare a run's workspace (feature 019 research D3, revised by 023): one
 * DETACHED worktree per repo under `worktreeRoot/<runId>/<repo.name>/`, each
 * at its own start ref — `origin/<continueBranch>` where a previous stage on
 * this ticket reported one for that repo, otherwise `origin/<defaultBranch>`.
 * Repos diverge independently; there is no run-level branch.
 *
 * `continueBranches` is keyed by `WorktreeRepo.name`. Matching agent-reported
 * repo names to workspace repos is the CALLER's job (see `prior-work.ts`) —
 * this module stays a pure git layer with no knowledge of report semantics.
 *
 * Sequential by design — repo counts are small and error attribution stays
 * deterministic. ALL-OR-NOTHING: a failure at repo N unwinds the N-1
 * worktrees already created and removes the parent dir (spec FR-008/SC-006),
 * then rethrows naming the failing repo.
 */
export async function prepareAll(
  repos: WorktreeRepo[],
  runId: string,
  worktreeRoot: string,
  repoCacheRoot: string,
  opts: { continueBranches?: Record<string, string> } = {},
): Promise<MultiPrepareResult> {
  if (repos.length === 0) {
    throw new WorktreePrepareError('no repositories to prepare for this run');
  }
  await mkdir(repoCacheRoot, { recursive: true });
  const parentDir = join(worktreeRoot, runId);
  await mkdir(parentDir, { recursive: true });

  const prepared: RepoWorktree[] = [];
  for (const repo of repos) {
    try {
      const cacheDir = await ensureCache(repo, repoCacheRoot);
      const worktreeDir = join(parentDir, repo.name);
      const start = await addRepoWorktree(
        repo,
        cacheDir,
        worktreeDir,
        opts.continueBranches?.[repo.name],
      );
      prepared.push({ repo, worktreeDir, cacheDir, start });
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

  return { parentDir, repos: prepared };
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

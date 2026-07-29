import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Hang-breaker on every git subprocess in this module (feature 034), NOT a
 * performance budget — hence generous. A `git fetch` on a dead TCP connection
 * or a `merge` waiting on an editor otherwise blocks the whole prepare phase
 * forever: the run's AbortSignal has no listener yet at that point, so nothing
 * else can end it. Deliberately local (not `GIT_OP_TIMEOUT_MS` from
 * `@brigadir/contracts` — that 30s value budgets small template repos; product
 * repo clones legitimately take minutes on a cold cache).
 */
export const WORKTREE_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * The one low-level runner every git call in this module goes through: the
 * hang-breaker timeout always applies; network-bound call sites additionally
 * thread the run's AbortSignal so an abort interrupts a transfer mid-flight.
 */
function gitExec(
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd: opts.cwd,
    timeout: WORKTREE_GIT_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

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
   * The concrete commit `startRef` resolved to in the fresh worktree (feature
   * 024). The completion gate's baseline: a worktree HEAD that has moved past
   * this SHA is unreported work if the report names no branch for the repo.
   */
  startSha: string;
  /**
   * Branch a previous stage on this ticket reported, verified present on
   * origin. Absent ⇒ this repo starts from its default branch.
   */
  continueBranch?: string;
  /**
   * Feature 032: additional blocker branches merged into the start point, in
   * merge order. Present only for a diamond (two or more blockers with work in
   * the same repository); `startSha` is resolved AFTER the last of them, so the
   * feature-024 completion gate's baseline includes the merged work.
   */
  mergedBranches?: string[];
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
    await gitExec(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
      cwd: cacheDir,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Feature 032: the same probe, exported for the executor's missing-branch
 * matrix, which must decide BEFORE any worktree is added whether a blocker's
 * reported branch is still on origin. Unlike a branch the ticket's OWN prior
 * work named — where a miss is a loud crash — a missing blocker branch is a
 * routine outcome (the blocker's PR merged and the branch was deleted), so this
 * answers with a boolean instead of throwing. An unusable branch NAME answers
 * `false` for the same reason: garbage in a blocker's report must not take the
 * dependent's run down with it.
 */
export async function branchExistsOnOrigin(cacheDir: string, branch: string): Promise<boolean> {
  try {
    await assertSafeBranchName(branch);
  } catch {
    return false;
  }
  return remoteBranchExists(cacheDir, branch);
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
    await gitExec(['check-ref-format', '--branch', branch]);
  } catch {
    throw new WorktreePrepareError(`reported branch name "${branch}" is not a valid branch name`);
  }
}

async function git(args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await gitExec(args, { cwd, signal });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new WorktreePrepareError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

/** Does `cacheDir` hold a repository git itself will accept? */
async function isHealthyRepo(cacheDir: string): Promise<boolean> {
  try {
    await gitExec(['rev-parse', '--git-dir'], { cwd: cacheDir });
    return true;
  } catch {
    return false;
  }
}

/** Can HEAD still be resolved to an object? Cheap probe for a gutted object store. */
async function headResolves(cacheDir: string): Promise<boolean> {
  try {
    await gitExec(['cat-file', '-e', 'HEAD'], { cwd: cacheDir });
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
async function ensureCache(
  repo: WorktreeRepo,
  repoCacheRoot: string,
  signal?: AbortSignal,
): Promise<string> {
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
      await git(['fetch', '--prune', 'origin'], cacheDir, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (await headResolves(cacheDir)) throw err;
      await rm(cacheDir, { recursive: true, force: true });
      await git(['clone', repo.url, cacheDir], undefined, signal);
    }
  } else {
    await git(['clone', repo.url, cacheDir], undefined, signal);
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
  mergeBranches: string[] = [],
): Promise<RepoStart> {
  let startRef = `origin/${repo.defaultBranch}`;
  let matchedContinue: string | undefined;
  if (continueBranch !== undefined) {
    await assertSafeBranchName(continueBranch);
    if (!(await remoteBranchExists(cacheDir, continueBranch))) {
      throw new WorktreePrepareError(
        `previous run reported branch "${continueBranch}" but origin has no such branch — ` +
          `push it or clear the stale report, then retry`,
      );
    }
    startRef = `origin/${continueBranch}`;
    matchedContinue = continueBranch;
  }
  try {
    await git(['worktree', 'add', '--detach', worktreeDir, startRef], cacheDir);
  } catch (err) {
    if (err instanceof WorktreePrepareError) throw err;
    throw new WorktreePrepareError(`cannot create worktree at "${startRef}": ${(err as Error).message}`);
  }

  // Feature 032: a diamond — two or more blockers left work in THIS repository.
  // The system merges them into the start point itself rather than picking one
  // arbitrarily (silent loss) or refusing to start (the chain stalls). Merging
  // is the system's job, not the agent's (Principle III's spirit: the agent is
  // told the merge already happened, and is never asked to perform it).
  const merged = await mergeIntoWorktree(repo, cacheDir, worktreeDir, startRef, mergeBranches);

  // Feature 024: pin the concrete commit the worktree started at — the gate's
  // baseline. Resolved AFTER any merge, so the merged work is part of the
  // baseline by construction and the completion gate stays unchanged.
  const startSha = (await git(['rev-parse', 'HEAD'], worktreeDir)).trim();
  return {
    startRef,
    startSha,
    continueBranch: matchedContinue,
    ...(merged.length > 0 ? { mergedBranches: merged } : {}),
  };
}

/**
 * Merge extra blocker branches into an already-detached worktree, sequentially
 * and in the given (deterministic) order.
 *
 * `--no-ff` on purpose: a merge commit exists even when the merge could
 * fast-forward, so "this run started from a combination of N branches" is
 * visible in `git log` rather than being indistinguishable from a plain
 * checkout. Commit identity is passed with `-c` — the system never writes a
 * global git config. A conflict is NOT resolved automatically: the merge is
 * aborted and the run fails loudly with the branches named, because a
 * machine-picked resolution of two agents' work is exactly the kind of silent
 * wrongness this codebase refuses.
 */
async function mergeIntoWorktree(
  repo: WorktreeRepo,
  cacheDir: string,
  worktreeDir: string,
  startRef: string,
  mergeBranches: string[],
): Promise<string[]> {
  const merged: string[] = [];
  for (const branch of mergeBranches) {
    await assertSafeBranchName(branch);
    if (!(await remoteBranchExists(cacheDir, branch))) {
      throw new WorktreePrepareError(
        `blocker branch "${branch}" is not on origin — cannot merge it into the start point`,
      );
    }
    try {
      await git(
        [
          '-c',
          'user.name=brigadir',
          '-c',
          'user.email=brigadir@local',
          'merge',
          '--no-ff',
          '-m',
          `brigadir: merge blocker branch ${branch} into ${startRef}`,
          `origin/${branch}`,
        ],
        worktreeDir,
      );
    } catch (err) {
      // Best-effort: leave no half-merged index behind for the unwind to trip on.
      await gitExec(['merge', '--abort'], { cwd: worktreeDir }).catch(() => {});
      throw new BlockerMergeConflictError(repo.name, startRef, mergeBranches, (err as Error).message);
    }
    merged.push(branch);
  }
  return merged;
}

/**
 * Feature 032: two blockers' branches for one repository do not merge cleanly.
 * A distinct subclass so the executor can recognize exactly this case and raise
 * the `[blocker_merge_conflict]` human task; everything else about it behaves
 * like any other prepare failure (all-or-nothing unwind, run marked crashed).
 */
export class BlockerMergeConflictError extends WorktreePrepareError {
  constructor(
    readonly repoName: string,
    readonly startRef: string,
    readonly mergeBranches: string[],
    detail: string,
  ) {
    super(
      `repo "${repoName}": blocker branches conflict — "${startRef}" + merge of [${mergeBranches
        .map((b) => `"${b}"`)
        .join(', ')}]: ${detail}`,
    );
    this.name = 'BlockerMergeConflictError';
  }
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
export async function ensureCaches(
  repos: WorktreeRepo[],
  repoCacheRoot: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  await mkdir(repoCacheRoot, { recursive: true });
  const caches: Record<string, string> = {};
  for (const repo of repos) {
    signal?.throwIfAborted();
    caches[repo.name] = await ensureCache(repo, repoCacheRoot, signal);
  }
  return caches;
}

export async function prepareAll(
  repos: WorktreeRepo[],
  runId: string,
  worktreeRoot: string,
  repoCacheRoot: string,
  opts: {
    continueBranches?: Record<string, string>;
    /** Feature 032: extra blocker branches to merge into each repo's start point. */
    mergeBranches?: Record<string, string[]>;
    /**
     * Feature 032: caches already ensured by {@link ensureCaches}. The executor
     * needs them BEFORE this call — the missing-branch matrix probes origin to
     * decide what to inherit — and re-fetching per repo here would be wasted
     * work. Absent ⇒ this function ensures them itself (pre-032 behaviour).
     */
    caches?: Record<string, string>;
    /** Feature 034: run abort interrupts any network git op mid-flight. */
    signal?: AbortSignal;
  } = {},
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
      opts.signal?.throwIfAborted();
      const cacheDir =
        opts.caches?.[repo.name] ?? (await ensureCache(repo, repoCacheRoot, opts.signal));
      const worktreeDir = join(parentDir, repo.name);
      const start = await addRepoWorktree(
        repo,
        cacheDir,
        worktreeDir,
        opts.continueBranches?.[repo.name],
        opts.mergeBranches?.[repo.name] ?? [],
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
      // Feature 032: the merge-conflict error already names its repo and its
      // branches, and the executor matches on its TYPE to raise the right human
      // task — re-wrapping would erase both.
      if (err instanceof BlockerMergeConflictError) throw err;
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

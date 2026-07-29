import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  prepareAll,
  cleanupAll,
  ensureCaches,
  branchExistsOnOrigin,
  WorktreePrepareError,
  type WorktreeRepo,
} from './worktree';

const execFileAsync = promisify(execFile);

async function initRemote(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main', dir]);
  await writeFile(join(dir, 'README.md'), '# test repo\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'],
    { cwd: dir },
  );
}

async function commitIn(worktreeDir: string, file: string): Promise<void> {
  await writeFile(join(worktreeDir, file), 'real work\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreeDir });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'agent work'],
    { cwd: worktreeDir },
  );
}

/**
 * What an agent does at the end of a stage: name a branch for the commits it
 * just made and push it. The next stage's start ref is resolved from origin,
 * so the push — not the local branch — is what makes the handoff work.
 */
async function pushBranchFrom(worktreeDir: string, branch: string): Promise<void> {
  await execFileAsync('git', ['-C', worktreeDir, 'switch', '-C', branch]);
  await execFileAsync('git', ['-C', worktreeDir, 'push', 'origin', branch]);
}

/** Detached HEAD ⇔ `symbolic-ref HEAD` does not resolve. */
async function isDetached(worktreeDir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', worktreeDir, 'symbolic-ref', '-q', 'HEAD']);
    return false;
  } catch {
    return true;
  }
}

async function revParse(dir: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', ref]);
  return stdout.trim();
}

describe('worktree prepareAll/cleanupAll (T080, feature 019 multi-repo; 023 detached start refs)', () => {
  let root: string;
  let remoteDir: string;
  let repo: WorktreeRepo;
  let worktreeRoot: string;
  let repoCacheRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-worktree-test-'));
    remoteDir = join(root, 'remote');
    await initRemote(remoteDir);
    repo = { name: 'product', url: remoteDir, defaultBranch: 'main' };
    worktreeRoot = join(root, 'worktrees');
    repoCacheRoot = join(root, 'repos');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const prep = (
    repos: WorktreeRepo[],
    runId: string,
    opts: { continueBranches?: Record<string, string> } = {},
  ) => prepareAll(repos, runId, worktreeRoot, repoCacheRoot, opts);

  it('creates a single-repo workspace detached at the default branch (no branch is created)', async () => {
    const result = await prep([repo], 'run-1');
    expect(result.parentDir).toBe(join(worktreeRoot, 'run-1'));
    expect(result.repos).toHaveLength(1);

    const wt = result.repos[0];
    expect(wt.worktreeDir).toBe(join(result.parentDir, 'product'));
    expect(existsSync(join(wt.worktreeDir, 'README.md'))).toBe(true);
    expect(wt.start.startRef).toBe('origin/main');
    expect(wt.start.continueBranch).toBeUndefined();
    // Feature 024 (US3): the resolved start SHA is the gate's baseline.
    expect(wt.start.startSha).toBe(await revParse(wt.worktreeDir, 'HEAD'));

    expect(await isDetached(wt.worktreeDir)).toBe(true);
    expect(await revParse(wt.worktreeDir, 'HEAD')).toBe(await revParse(wt.cacheDir, 'origin/main'));

    // The system creates no branch of its own — only the clone's own `main` is
    // there, no `<prefix>/<ticket>` head for a later run to collide with.
    const { stdout: branches } = await execFileAsync('git', [
      '-C',
      wt.cacheDir,
      'branch',
      '--format=%(refname:short)',
    ]);
    expect(branches.trim().split('\n')).toEqual(['main']);
  });

  it('rejects an empty repository list loudly', async () => {
    await expect(prep([], 'run-0')).rejects.toThrow(/no repositories/);
  });

  it('two runs prepare from the same start ref concurrently (the ST3-780 crash, now impossible)', async () => {
    const first = await prep([repo], 'run-1');
    const second = await prep([repo], 'run-2');
    expect(await revParse(first.repos[0].worktreeDir, 'HEAD')).toBe(
      await revParse(second.repos[0].worktreeDir, 'HEAD'),
    );
  });

  it('continues a branch a previous stage pushed: detached at its tip, prior commit present', async () => {
    const first = await prep([repo], 'run-1');
    await commitIn(first.repos[0].worktreeDir, 'work.txt');
    await pushBranchFrom(first.repos[0].worktreeDir, 'run/BRIG-7');
    await cleanupAll(first);

    const second = await prep([repo], 'run-2', { continueBranches: { product: 'run/BRIG-7' } });
    const wt = second.repos[0];
    expect(wt.start.startRef).toBe('origin/run/BRIG-7');
    expect(wt.start.continueBranch).toBe('run/BRIG-7');
    // Feature 024 (US3): startSha is the tip of the continued branch.
    expect(wt.start.startSha).toBe(await revParse(wt.worktreeDir, 'HEAD'));
    expect(wt.start.startSha).toBe(await revParse(wt.cacheDir, 'origin/run/BRIG-7'));
    expect(await isDetached(wt.worktreeDir)).toBe(true);
    expect(existsSync(join(wt.worktreeDir, 'work.txt'))).toBe(true);
  });

  it('a reported branch that is NOT on origin fails loudly and unwinds (never falls back to the default branch)', async () => {
    await expect(prep([repo], 'run-2', { continueBranches: { product: 'run/GONE' } })).rejects.toThrow(
      /repo "product".*origin has no such branch/s,
    );
    expect(existsSync(join(worktreeRoot, 'run-2'))).toBe(false);
  });

  it('a branch deleted on origin is NOT resurrected from a stale remote-tracking ref (pins fetch --prune)', async () => {
    const first = await prep([repo], 'run-1');
    await commitIn(first.repos[0].worktreeDir, 'work.txt');
    await pushBranchFrom(first.repos[0].worktreeDir, 'run/BRIG-8');
    await cleanupAll(first);
    // Warm the cache so `refs/remotes/origin/run/BRIG-8` exists locally...
    await cleanupAll(await prep([repo], 'run-warm', { continueBranches: { product: 'run/BRIG-8' } }));
    // ...then the branch goes away upstream (merged and deleted, say).
    await execFileAsync('git', ['-C', remoteDir, 'branch', '-D', 'run/BRIG-8']);

    await expect(
      prep([repo], 'run-3', { continueBranches: { product: 'run/BRIG-8' } }),
    ).rejects.toThrow(/origin has no such branch/);
  });

  it.each(['--upload-pack=evil', 'has space', '..', ''])(
    'rejects the malformed reported branch name %j before touching git',
    async (bad) => {
      await expect(prep([repo], 'run-bad', { continueBranches: { product: bad } })).rejects.toThrow(
        /not a valid branch name/,
      );
    },
  );

  it('cleanupAll removes worktrees, their git admin entries and the parent dir', async () => {
    const result = await prep([repo], 'run-3');
    await cleanupAll(result);

    expect(existsSync(result.repos[0].worktreeDir)).toBe(false);
    expect(existsSync(result.parentDir)).toBe(false);

    const { stdout: list } = await execFileAsync('git', [
      '-C',
      result.repos[0].cacheDir,
      'worktree',
      'list',
    ]);
    expect(list).not.toContain(result.repos[0].worktreeDir);
  });

  it('cleanupAll({ keep: true }) leaves the whole parent dir in place (failed-run inspection)', async () => {
    const result = await prep([repo], 'run-4');
    await cleanupAll(result, { keep: true });
    expect(existsSync(result.parentDir)).toBe(true);
    expect(existsSync(join(result.repos[0].worktreeDir, 'README.md'))).toBe(true);
  });

  it('a second run against the same repo reuses the cached clone (fetch, not re-clone)', async () => {
    const first = await prep([repo], 'run-5');
    const second = await prep([repo], 'run-6');
    expect(first.repos[0].cacheDir).toBe(second.repos[0].cacheDir);
    expect(existsSync(join(second.repos[0].worktreeDir, 'README.md'))).toBe(true);
  });

  /**
   * Live incident 2026-07-18 (ST3-780): the macOS `$TMPDIR` reaper deletes
   * FILES older than ~3 days but leaves DIRECTORIES, gutting a cached clone
   * into a skeleton — `.git/` still there, `HEAD` and refs gone. The old
   * `existsSync('.git')` check read that as "already cloned", fetched into it,
   * and died with `fatal: not a git repository` on every retry, forever.
   */
  describe('cache self-healing (incident 2026-07-18)', () => {
    /** Break the cache the way the reaper did: keep `.git/`, remove `HEAD`. */
    const gutHead = (cacheDir: string) => rm(join(cacheDir, '.git', 'HEAD'), { force: true });

    /** Point the cache's origin at nothing, so `fetch` fails while `clone` still works. */
    const breakOrigin = (cacheDir: string) =>
      execFileAsync('git', ['-C', cacheDir, 'remote', 'set-url', 'origin', join(root, 'gone')]);

    it('re-clones a cache the reaper gutted instead of failing forever', async () => {
      const first = await prep([repo], 'run-rot-1');
      const cacheDir = first.repos[0].cacheDir;
      await cleanupAll(first);
      await gutHead(cacheDir);

      const healed = await prep([repo], 'run-rot-2');

      expect(healed.repos[0].cacheDir).toBe(cacheDir);
      expect(existsSync(join(cacheDir, '.git', 'HEAD'))).toBe(true);
      expect(existsSync(join(healed.repos[0].worktreeDir, 'README.md'))).toBe(true);
    });

    it('re-clones when fetch fails AND HEAD no longer resolves (partially reaped object store)', async () => {
      const first = await prep([repo], 'run-rot-3');
      const cacheDir = first.repos[0].cacheDir;
      await cleanupAll(first);
      await breakOrigin(cacheDir);
      await rm(join(cacheDir, '.git', 'objects'), { recursive: true, force: true });

      const healed = await prep([repo], 'run-rot-4');

      expect(existsSync(join(healed.repos[0].worktreeDir, 'README.md'))).toBe(true);
    });

    it('a fetch failure over a HEALTHY cache propagates and does NOT discard the cache (network/auth, not rot)', async () => {
      const first = await prep([repo], 'run-net-1');
      const cacheDir = first.repos[0].cacheDir;
      await cleanupAll(first);
      await breakOrigin(cacheDir);

      await expect(prep([repo], 'run-net-2')).rejects.toThrow(WorktreePrepareError);
      // The cache survived: re-cloning on a network blip costs a full clone and fixes nothing.
      expect(existsSync(join(cacheDir, '.git', 'HEAD'))).toBe(true);
    });
  });

  describe('multi-repo (feature 019)', () => {
    let infra: WorktreeRepo;

    beforeEach(async () => {
      const infraRemote = join(root, 'infra-remote');
      await initRemote(infraRemote);
      infra = { name: 'infra', url: infraRemote, defaultBranch: 'main' };
    });

    it('prepares one worktree per repo under the parent, each detached at its own default branch', async () => {
      const result = await prep([repo, infra], 'run-m1');
      expect(result.repos.map((r) => r.worktreeDir)).toEqual([
        join(worktreeRoot, 'run-m1', 'product'),
        join(worktreeRoot, 'run-m1', 'infra'),
      ]);
      for (const r of result.repos) {
        expect(r.start.startRef).toBe('origin/main');
        expect(r.start.continueBranch).toBeUndefined();
        expect(r.start.startSha).toBe(await revParse(r.worktreeDir, 'HEAD'));
        expect(await isDetached(r.worktreeDir)).toBe(true);
      }
      // Independent caches, one per repo name.
      expect(result.repos[0].cacheDir).toBe(join(repoCacheRoot, 'product'));
      expect(result.repos[1].cacheDir).toBe(join(repoCacheRoot, 'infra'));
    });

    it('repos diverge independently: one continues a branch, the other starts from its default', async () => {
      // A previous stage changed only `product` and pushed its branch there.
      const first = await prep([repo], 'run-m7');
      await commitIn(first.repos[0].worktreeDir, 'work.txt');
      await pushBranchFrom(first.repos[0].worktreeDir, 'run/BRIG-24');
      await cleanupAll(first);

      // The next stage mounts BOTH repos; only `product` has prior work.
      const next = await prep([repo, infra], 'run-m8', {
        continueBranches: { product: 'run/BRIG-24' },
      });
      expect(next.repos[0].start.continueBranch).toBe('run/BRIG-24');
      expect(existsSync(join(next.repos[0].worktreeDir, 'work.txt'))).toBe(true);
      expect(next.repos[1].start.startRef).toBe('origin/main');
      expect(next.repos[1].start.continueBranch).toBeUndefined();
    });

    it('partial failure unwinds already-created worktrees and removes the parent dir (SC-006)', async () => {
      const broken: WorktreeRepo = { name: 'broken', url: join(root, 'nonexistent'), defaultBranch: 'main' };
      await expect(prep([repo, broken], 'run-m2')).rejects.toThrow(/repo "broken"/);

      // Nothing left behind for this run:
      expect(existsSync(join(worktreeRoot, 'run-m2'))).toBe(false);
      // The first repo's cache holds no worktree entry for the unwound dir.
      const { stdout: list } = await execFileAsync('git', [
        '-C',
        join(repoCacheRoot, 'product'),
        'worktree',
        'list',
      ]);
      expect(list).not.toContain('run-m2');
    });

    it('a missing reported branch in the SECOND repo fails the whole prepare, naming the repo', async () => {
      await expect(
        prep([repo, infra], 'run-m4', { continueBranches: { infra: 'run/NOPE' } }),
      ).rejects.toThrow(/repo "infra".*origin has no such branch/s);
      // The unwind also removed product's already-created worktree + parent.
      expect(existsSync(join(worktreeRoot, 'run-m4'))).toBe(false);
    });

    it('cleanupAll removes every repo worktree and the parent dir', async () => {
      const result = await prep([repo, infra], 'run-m9');
      await cleanupAll(result);
      expect(existsSync(result.parentDir)).toBe(false);
      for (const r of result.repos) expect(existsSync(r.worktreeDir)).toBe(false);
    });
  });
});

// Feature 024 (US2): `setupRunBranchIdentity` was deleted — the wrapper no
// longer suggests a branch name to any run, setup runs included. Its removal
// is covered by the executor wrapper-text assertions (no `create …` line) and
// the grep sweep in the tasks list.

/**
 * Feature 032 (T039): merging two blockers' branches into one repository's
 * start point. Real git in temp dirs — the merge semantics (`--no-ff`, the
 * post-merge startSha, the conflict abort) are the whole point, and a mock
 * would prove none of them.
 */
describe('worktree prepareAll — blocker branch merges (feature 032)', () => {
  let root: string;
  let remoteDir: string;
  let repo: WorktreeRepo;
  let worktreeRoot: string;
  let repoCacheRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-merge-test-'));
    remoteDir = join(root, 'remote');
    await initRemote(remoteDir);
    repo = { name: 'product', url: remoteDir, defaultBranch: 'main' };
    worktreeRoot = join(root, 'worktrees');
    repoCacheRoot = join(root, 'repos');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const prep = (
    repos: WorktreeRepo[],
    runId: string,
    opts: {
      continueBranches?: Record<string, string>;
      mergeBranches?: Record<string, string[]>;
    } = {},
  ) => prepareAll(repos, runId, worktreeRoot, repoCacheRoot, opts);

  /** Push a branch carrying one commit that writes `file`. */
  async function seedBranch(branch: string, file: string, content = 'work\n'): Promise<void> {
    const prepared = await prep([repo], `seed-${branch.replace(/\W/g, '-')}`);
    const wt = prepared.repos[0].worktreeDir;
    await writeFile(join(wt, file), content);
    await execFileAsync('git', ['add', '-A'], { cwd: wt });
    await execFileAsync(
      'git',
      ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', `work on ${branch}`],
      { cwd: wt },
    );
    await execFileAsync('git', ['-C', wt, 'switch', '-C', branch]);
    await execFileAsync('git', ['-C', wt, 'push', 'origin', branch]);
    await cleanupAll(prepared);
  }

  it('merges a second blocker branch into the start point and records the order', async () => {
    await seedBranch('run/A', 'a.txt');
    await seedBranch('run/B', 'b.txt');

    const result = await prep([repo], 'run-merge', {
      continueBranches: { product: 'run/A' },
      mergeBranches: { product: ['run/B'] },
    });
    const wt = result.repos[0];

    // Both blockers' files are present in the start point.
    expect(existsSync(join(wt.worktreeDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(wt.worktreeDir, 'b.txt'))).toBe(true);
    expect(wt.start.mergedBranches).toEqual(['run/B']);
    expect(wt.start.continueBranch).toBe('run/A');
  });

  it('startSha is resolved AFTER the merge — the completion gate baseline includes it', async () => {
    await seedBranch('run/A', 'a.txt');
    await seedBranch('run/B', 'b.txt');

    const result = await prep([repo], 'run-sha', {
      continueBranches: { product: 'run/A' },
      mergeBranches: { product: ['run/B'] },
    });
    const wt = result.repos[0];
    expect(wt.start.startSha).toBe(await revParse(wt.worktreeDir, 'HEAD'));
    // Not the tip of either input branch — it is the new merge commit.
    expect(wt.start.startSha).not.toBe(await revParse(wt.cacheDir, 'origin/run/A'));
    expect(wt.start.startSha).not.toBe(await revParse(wt.cacheDir, 'origin/run/B'));
  });

  it('--no-ff: a merge commit exists even when the merge could fast-forward', async () => {
    await seedBranch('run/A', 'a.txt');
    // run/AHEAD builds directly on run/A, so merging it would fast-forward.
    const prepared = await prep([repo], 'seed-ahead', { continueBranches: { product: 'run/A' } });
    const wt0 = prepared.repos[0].worktreeDir;
    await writeFile(join(wt0, 'ahead.txt'), 'more\n');
    await execFileAsync('git', ['add', '-A'], { cwd: wt0 });
    await execFileAsync(
      'git',
      ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'ahead'],
      { cwd: wt0 },
    );
    await execFileAsync('git', ['-C', wt0, 'switch', '-C', 'run/AHEAD']);
    await execFileAsync('git', ['-C', wt0, 'push', 'origin', 'run/AHEAD']);
    await cleanupAll(prepared);

    const result = await prep([repo], 'run-noff', {
      continueBranches: { product: 'run/A' },
      mergeBranches: { product: ['run/AHEAD'] },
    });
    const wt = result.repos[0].worktreeDir;
    const { stdout } = await execFileAsync('git', ['-C', wt, 'rev-list', '--merges', '-n', '1', 'HEAD']);
    expect(stdout.trim()).not.toBe('');
  });

  it('merges three branches in the given order', async () => {
    await seedBranch('run/A', 'a.txt');
    await seedBranch('run/B', 'b.txt');
    await seedBranch('run/C', 'c.txt');

    const result = await prep([repo], 'run-three', {
      continueBranches: { product: 'run/A' },
      mergeBranches: { product: ['run/B', 'run/C'] },
    });
    expect(result.repos[0].start.mergedBranches).toEqual(['run/B', 'run/C']);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      expect(existsSync(join(result.repos[0].worktreeDir, f))).toBe(true);
    }
  });

  it('a conflicting merge fails loudly, names repo + branches, and unwinds everything', async () => {
    // Both branches change the SAME file differently ⇒ guaranteed conflict.
    await seedBranch('run/A', 'shared.txt', 'from A\n');
    await seedBranch('run/B', 'shared.txt', 'from B\n');

    await expect(
      prep([repo], 'run-conflict', {
        continueBranches: { product: 'run/A' },
        mergeBranches: { product: ['run/B'] },
      }),
    ).rejects.toMatchObject({
      name: 'BlockerMergeConflictError',
      repoName: 'product',
      mergeBranches: ['run/B'],
    });
    // All-or-nothing: no half-prepared workspace survives.
    expect(existsSync(join(worktreeRoot, 'run-conflict'))).toBe(false);
  });

  it('a merge branch that is not on origin is rejected before any merge happens', async () => {
    await seedBranch('run/A', 'a.txt');
    await expect(
      prep([repo], 'run-missing-merge', {
        continueBranches: { product: 'run/A' },
        mergeBranches: { product: ['run/NEVER-PUSHED'] },
      }),
    ).rejects.toThrow(/is not on origin/);
  });

  it('rejects a malformed merge branch name', async () => {
    await seedBranch('run/A', 'a.txt');
    await expect(
      prep([repo], 'run-bad-merge', {
        continueBranches: { product: 'run/A' },
        mergeBranches: { product: ['--upload-pack=evil'] },
      }),
    ).rejects.toThrow(/not a valid branch name/);
  });

  it('no mergeBranches ⇒ byte-identical to feature 023 (no merge commit, no field)', async () => {
    await seedBranch('run/A', 'a.txt');
    const result = await prep([repo], 'run-plain', { continueBranches: { product: 'run/A' } });
    expect(result.repos[0].start.mergedBranches).toBeUndefined();
    expect(result.repos[0].start.startSha).toBe(
      await revParse(result.repos[0].cacheDir, 'origin/run/A'),
    );
  });
});

describe('branchExistsOnOrigin (feature 032)', () => {
  let root: string;
  let repoCacheRoot: string;
  let repo: WorktreeRepo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-probe-test-'));
    const remoteDir = join(root, 'remote');
    await initRemote(remoteDir);
    repo = { name: 'product', url: remoteDir, defaultBranch: 'main' };
    repoCacheRoot = join(root, 'repos');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('answers true/false instead of throwing — a missing blocker branch is routine', async () => {
    const caches = await ensureCaches([repo], repoCacheRoot);
    expect(await branchExistsOnOrigin(caches.product, 'main')).toBe(true);
    expect(await branchExistsOnOrigin(caches.product, 'run/NOPE')).toBe(false);
  });

  it('answers false (not throw) for an unusable branch name from a blocker report', async () => {
    const caches = await ensureCaches([repo], repoCacheRoot);
    expect(await branchExistsOnOrigin(caches.product, '--upload-pack=evil')).toBe(false);
    expect(await branchExistsOnOrigin(caches.product, '')).toBe(false);
  });
});

/**
 * Feature 034: the prepare phase is abortable — the run's AbortSignal threads
 * into the network git ops, and boundary checks stop work between repos. (The
 * per-command WORKTREE_GIT_TIMEOUT_MS hang-breaker is exercised implicitly by
 * every test above: all git calls run through the same gitExec wrapper.)
 */
describe('abortable prepare (feature 034)', () => {
  let root: string;
  let remoteDir: string;
  let repo: WorktreeRepo;
  let worktreeRoot: string;
  let repoCacheRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-worktree-abort-'));
    remoteDir = join(root, 'remote');
    await initRemote(remoteDir);
    repo = { name: 'product', url: remoteDir, defaultBranch: 'main' };
    worktreeRoot = join(root, 'worktrees');
    repoCacheRoot = join(root, 'repos');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ensureCaches with a pre-aborted signal throws before cloning anything', async () => {
    const controller = new AbortController();
    controller.abort('timeout');
    await expect(ensureCaches([repo], repoCacheRoot, controller.signal)).rejects.toThrow();
    expect(existsSync(join(repoCacheRoot, 'product'))).toBe(false);
  });

  it('prepareAll with a pre-aborted signal throws and leaves no workspace behind', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(
      prepareAll([repo], 'run-abort-1', worktreeRoot, repoCacheRoot, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(worktreeRoot, 'run-abort-1'))).toBe(false);
  });

  it('an un-aborted signal changes nothing — the workspace prepares normally', async () => {
    const controller = new AbortController();
    const ws = await prepareAll([repo], 'run-abort-2', worktreeRoot, repoCacheRoot, {
      signal: controller.signal,
    });
    expect(ws.repos).toHaveLength(1);
    expect(existsSync(ws.repos[0].worktreeDir)).toBe(true);
    await cleanupAll(ws);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepare, cleanup, WorktreePrepareError, type WorktreeRepo } from './worktree';

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

describe('worktree prepare/cleanup (T080)', () => {
  let root: string;
  let repo: WorktreeRepo;
  let worktreeRoot: string;
  let repoCacheRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-worktree-test-'));
    const remoteDir = join(root, 'remote');
    await initRemote(remoteDir);
    repo = { name: 'product', url: remoteDir, defaultBranch: 'main' };
    worktreeRoot = join(root, 'worktrees');
    repoCacheRoot = join(root, 'repos');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a worktree on the expected branch name', async () => {
    const result = await prepare(repo, 'run-1', 'BRIG-1', 'feat', worktreeRoot, repoCacheRoot);
    expect(result.branch).toBe('feat/BRIG-1');
    expect(existsSync(join(result.worktreeDir, 'README.md'))).toBe(true);

    const { stdout } = await execFileAsync('git', ['-C', result.worktreeDir, 'branch', '--show-current']);
    expect(stdout.trim()).toBe('feat/BRIG-1');
  });

  it('calling prepare again while the branch is still checked out in a live worktree throws', async () => {
    await prepare(repo, 'run-1', 'BRIG-2', 'feat', worktreeRoot, repoCacheRoot);
    await expect(prepare(repo, 'run-2', 'BRIG-2', 'feat', worktreeRoot, repoCacheRoot)).rejects.toThrow(
      WorktreePrepareError,
    );
  });

  it('an EMPTY leftover branch (failed attempt, no commits) is deleted and prepare succeeds (retry path, incident 2026-07-14)', async () => {
    const first = await prepare(repo, 'run-1', 'BRIG-9', 'feat', worktreeRoot, repoCacheRoot);
    await cleanup(first.cacheDir, first.worktreeDir); // removes worktree, leaves branch
    const second = await prepare(repo, 'run-2', 'BRIG-9', 'feat', worktreeRoot, repoCacheRoot);
    expect(second.branch).toBe('feat/BRIG-9');
    expect(existsSync(join(second.worktreeDir, 'README.md'))).toBe(true);
  });

  it('a leftover branch WITH commits is refused loudly (real prior work is never discarded)', async () => {
    const first = await prepare(repo, 'run-1', 'BRIG-10', 'feat', worktreeRoot, repoCacheRoot);
    await writeFile(join(first.worktreeDir, 'work.txt'), 'real work\n');
    await execFileAsync('git', ['add', '-A'], { cwd: first.worktreeDir });
    await execFileAsync(
      'git',
      ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'agent work'],
      { cwd: first.worktreeDir },
    );
    await cleanup(first.cacheDir, first.worktreeDir);
    await expect(prepare(repo, 'run-2', 'BRIG-10', 'feat', worktreeRoot, repoCacheRoot)).rejects.toThrow(
      /commit\(s\) of prior work/,
    );
  });

  it('cleanup removes the worktree directory and its git worktree list entry, but leaves the branch intact', async () => {
    const result = await prepare(repo, 'run-3', 'BRIG-3', 'feat', worktreeRoot, repoCacheRoot);
    await cleanup(result.cacheDir, result.worktreeDir);

    expect(existsSync(result.worktreeDir)).toBe(false);

    const { stdout: list } = await execFileAsync('git', ['-C', result.cacheDir, 'worktree', 'list']);
    expect(list).not.toContain(result.worktreeDir);

    const { stdout: branches } = await execFileAsync('git', [
      '-C',
      result.cacheDir,
      'branch',
      '--list',
      'feat/BRIG-3',
    ]);
    expect(branches.trim()).not.toBe('');
  });

  it('cleanup({ keep: true }) leaves the directory in place', async () => {
    const result = await prepare(repo, 'run-4', 'BRIG-4', 'feat', worktreeRoot, repoCacheRoot);
    await cleanup(result.cacheDir, result.worktreeDir, { keep: true });
    expect(existsSync(result.worktreeDir)).toBe(true);
  });

  it('a second run against the same repo reuses the cached clone (fetch, not re-clone)', async () => {
    const first = await prepare(repo, 'run-5', 'BRIG-5', 'feat', worktreeRoot, repoCacheRoot);
    const second = await prepare(repo, 'run-6', 'BRIG-6', 'feat', worktreeRoot, repoCacheRoot);
    expect(first.cacheDir).toBe(second.cacheDir);
    expect(existsSync(join(second.worktreeDir, 'README.md'))).toBe(true);
  });

  it('{reuseBranch:true} (feature 004 resume) attaches a worktree to an already-existing branch instead of failing', async () => {
    const first = await prepare(repo, 'run-7', 'BRIG-7', 'feat', worktreeRoot, repoCacheRoot);
    await execFileAsync(
      'git',
      ['-C', first.worktreeDir, '-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'wip'],
    );
    await cleanup(first.cacheDir, first.worktreeDir);

    const resumed = await prepare(repo, 'run-8', 'BRIG-7', 'feat', worktreeRoot, repoCacheRoot, {
      reuseBranch: true,
    });
    expect(resumed.branch).toBe('feat/BRIG-7');
    const { stdout } = await execFileAsync('git', ['-C', resumed.worktreeDir, 'log', '--oneline', '-1']);
    expect(stdout).toContain('wip'); // continues the same branch, prior commit intact
  });
});

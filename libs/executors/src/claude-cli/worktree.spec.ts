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
  setupRunBranchIdentity,
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

describe('worktree prepareAll/cleanupAll (T080, feature 019 multi-repo)', () => {
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

  const prep = (
    repos: WorktreeRepo[],
    runId: string,
    ticketKey: string,
    opts: { reuseBranch?: boolean } = {},
  ) => prepareAll(repos, runId, ticketKey, 'feat', worktreeRoot, repoCacheRoot, opts);

  it('creates a single-repo workspace: parent dir + repo worktree on the expected branch', async () => {
    const result = await prep([repo], 'run-1', 'BRIG-1');
    expect(result.branch).toBe('feat/BRIG-1');
    expect(result.parentDir).toBe(join(worktreeRoot, 'run-1'));
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].worktreeDir).toBe(join(result.parentDir, 'product'));
    expect(existsSync(join(result.repos[0].worktreeDir, 'README.md'))).toBe(true);

    const { stdout } = await execFileAsync('git', [
      '-C',
      result.repos[0].worktreeDir,
      'branch',
      '--show-current',
    ]);
    expect(stdout.trim()).toBe('feat/BRIG-1');
  });

  it('rejects an empty repository list loudly', async () => {
    await expect(prep([], 'run-0', 'BRIG-0')).rejects.toThrow(/no repositories/);
  });

  it('calling prepareAll again while the branch is still checked out in a live worktree throws', async () => {
    await prep([repo], 'run-1', 'BRIG-2');
    await expect(prep([repo], 'run-2', 'BRIG-2')).rejects.toThrow(WorktreePrepareError);
  });

  it('an EMPTY leftover branch (failed attempt, no commits) is deleted and prepare succeeds (retry path, incident 2026-07-14)', async () => {
    const first = await prep([repo], 'run-1', 'BRIG-9');
    await cleanupAll(first); // removes worktrees + parent, leaves branch
    const second = await prep([repo], 'run-2', 'BRIG-9');
    expect(second.branch).toBe('feat/BRIG-9');
    expect(existsSync(join(second.repos[0].worktreeDir, 'README.md'))).toBe(true);
  });

  it('a leftover branch WITH commits is refused loudly (real prior work is never discarded)', async () => {
    const first = await prep([repo], 'run-1', 'BRIG-10');
    await commitIn(first.repos[0].worktreeDir, 'work.txt');
    await cleanupAll(first);
    await expect(prep([repo], 'run-2', 'BRIG-10')).rejects.toThrow(/commit\(s\) of prior work/);
  });

  it('cleanupAll removes worktrees, their git admin entries and the parent dir, but leaves branches intact', async () => {
    const result = await prep([repo], 'run-3', 'BRIG-3');
    await cleanupAll(result);

    expect(existsSync(result.repos[0].worktreeDir)).toBe(false);
    expect(existsSync(result.parentDir)).toBe(false);

    const cacheDir = result.repos[0].cacheDir;
    const { stdout: list } = await execFileAsync('git', ['-C', cacheDir, 'worktree', 'list']);
    expect(list).not.toContain(result.repos[0].worktreeDir);

    const { stdout: branches } = await execFileAsync('git', [
      '-C',
      cacheDir,
      'branch',
      '--list',
      'feat/BRIG-3',
    ]);
    expect(branches.trim()).not.toBe('');
  });

  it('cleanupAll({ keep: true }) leaves the whole parent dir in place (failed-run inspection)', async () => {
    const result = await prep([repo], 'run-4', 'BRIG-4');
    await cleanupAll(result, { keep: true });
    expect(existsSync(result.parentDir)).toBe(true);
    expect(existsSync(join(result.repos[0].worktreeDir, 'README.md'))).toBe(true);
  });

  it('a second run against the same repo reuses the cached clone (fetch, not re-clone)', async () => {
    const first = await prep([repo], 'run-5', 'BRIG-5');
    const second = await prep([repo], 'run-6', 'BRIG-6');
    expect(first.repos[0].cacheDir).toBe(second.repos[0].cacheDir);
    expect(existsSync(join(second.repos[0].worktreeDir, 'README.md'))).toBe(true);
  });

  it('{reuseBranch:true} (feature 004 resume) attaches a worktree to an already-existing branch instead of failing', async () => {
    const first = await prep([repo], 'run-7', 'BRIG-7');
    await execFileAsync('git', [
      '-C',
      first.repos[0].worktreeDir,
      '-c',
      'user.email=t@t.com',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-m',
      'wip',
    ]);
    await cleanupAll(first);

    const resumed = await prep([repo], 'run-8', 'BRIG-7', { reuseBranch: true });
    expect(resumed.branch).toBe('feat/BRIG-7');
    const { stdout } = await execFileAsync('git', [
      '-C',
      resumed.repos[0].worktreeDir,
      'log',
      '--oneline',
      '-1',
    ]);
    expect(stdout).toContain('wip'); // continues the same branch, prior commit intact
  });

  describe('multi-repo (feature 019)', () => {
    let infra: WorktreeRepo;

    beforeEach(async () => {
      const infraRemote = join(root, 'infra-remote');
      await initRemote(infraRemote);
      infra = { name: 'infra', url: infraRemote, defaultBranch: 'main' };
    });

    it('prepares one worktree per repo under the parent, all on the SAME branch', async () => {
      const result = await prep([repo, infra], 'run-m1', 'BRIG-20');
      expect(result.repos.map((r) => r.worktreeDir)).toEqual([
        join(worktreeRoot, 'run-m1', 'product'),
        join(worktreeRoot, 'run-m1', 'infra'),
      ]);
      for (const r of result.repos) {
        const { stdout } = await execFileAsync('git', ['-C', r.worktreeDir, 'branch', '--show-current']);
        expect(stdout.trim()).toBe('feat/BRIG-20');
      }
      // Independent caches, one per repo name.
      expect(result.repos[0].cacheDir).toBe(join(repoCacheRoot, 'product'));
      expect(result.repos[1].cacheDir).toBe(join(repoCacheRoot, 'infra'));
    });

    it('partial failure unwinds already-created worktrees and removes the parent dir (SC-006)', async () => {
      const broken: WorktreeRepo = { name: 'broken', url: join(root, 'nonexistent'), defaultBranch: 'main' };
      await expect(prep([repo, broken], 'run-m2', 'BRIG-21')).rejects.toThrow(/repo "broken"/);

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

    it('a with-commits leftover in the SECOND repo fails the whole prepare, naming the repo', async () => {
      const first = await prep([repo, infra], 'run-m3', 'BRIG-22');
      await commitIn(first.repos[1].worktreeDir, 'infra.txt'); // prior work only in infra
      await cleanupAll(first);

      await expect(prep([repo, infra], 'run-m4', 'BRIG-22')).rejects.toThrow(
        /repo "infra".*commit\(s\) of prior work/s,
      );
      // The unwind also removed product's (freshly recreated) worktree + parent.
      expect(existsSync(join(worktreeRoot, 'run-m4'))).toBe(false);
    });

    it('zero-commit leftovers in BOTH repos are reclaimed silently on the next run (SC-003)', async () => {
      const first = await prep([repo, infra], 'run-m5', 'BRIG-23');
      await cleanupAll(first); // leaves feat/BRIG-23 in both caches, zero commits
      const second = await prep([repo, infra], 'run-m6', 'BRIG-23');
      expect(second.repos).toHaveLength(2);
    });

    it('{reuseBranch:true} attaches where the branch exists and CREATES where it is missing (research D4)', async () => {
      // First attempt ran with only `product` in scope and committed there.
      const first = await prep([repo], 'run-m7', 'BRIG-24');
      await commitIn(first.repos[0].worktreeDir, 'work.txt');
      await cleanupAll(first);

      // Resume runs with a WIDENED scope: product resumes its branch, infra
      // (no such branch yet) gets a fresh one instead of failing the resume.
      const resumed = await prep([repo, infra], 'run-m8', 'BRIG-24', { reuseBranch: true });
      const { stdout: productLog } = await execFileAsync('git', [
        '-C',
        resumed.repos[0].worktreeDir,
        'log',
        '--oneline',
        '-1',
      ]);
      expect(productLog).toContain('agent work');
      const { stdout: infraBranch } = await execFileAsync('git', [
        '-C',
        resumed.repos[1].worktreeDir,
        'branch',
        '--show-current',
      ]);
      expect(infraBranch.trim()).toBe('feat/BRIG-24');
    });

    it('cleanupAll removes every repo worktree and the parent dir', async () => {
      const result = await prep([repo, infra], 'run-m9', 'BRIG-25');
      await cleanupAll(result);
      expect(existsSync(result.parentDir)).toBe(false);
      for (const r of result.repos) expect(existsSync(r.worktreeDir)).toBe(false);
    });
  });
});

/**
 * Feature 015 (FR-020): a ticketless workspace-setup run gets the branch
 * identity `setup/<first 8 chars of run id>` — fed into prepareAll() through
 * the standard (branchPrefix, ticketKey) parameters, so the leftover policy
 * and cleanup behave exactly like ticket branches.
 */
describe('setupRunBranchIdentity (feature 015)', () => {
  it('derives setup/<runId8> from the run id', () => {
    const id = setupRunBranchIdentity('a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    expect(id).toEqual({ branchPrefix: 'setup', ticketKey: 'a1b2c3d4' });
    // prepareAll() composes them the same way it composes ticket branches.
    expect(`${id.branchPrefix}/${id.ticketKey}`).toBe('setup/a1b2c3d4');
  });

  it('is deterministic and collision-free across distinct run ids', () => {
    const a = setupRunBranchIdentity('aaaaaaaa-1111');
    const b = setupRunBranchIdentity('bbbbbbbb-2222');
    expect(a).toEqual(setupRunBranchIdentity('aaaaaaaa-1111'));
    expect(a.ticketKey).not.toBe(b.ticketKey);
  });
});

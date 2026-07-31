import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBootstrap, dirtyGuard, BOOTSTRAP_TAIL_BYTES } from './bootstrap';

const execFileAsync = promisify(execFile);

/**
 * Feature 035 — real processes and a real git repo, no mocks: this module IS
 * the layer that shells out, so its spec exercises /bin/sh and git directly
 * (same convention as worktree.spec.ts).
 */

const BASE_ENV: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main', dir]);
  await writeFile(join(dir, 'tracked.txt'), 'original\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'init'],
    { cwd: dir },
  );
}

describe('runBootstrap (feature 035)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brigadir-bootstrap-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the command in the worktree with the given env and captures the tails', async () => {
    const result = await runBootstrap({
      worktreeDir: dir,
      command: 'echo "cache=$npm_config_cache" && pwd && echo oops >&2',
      env: { ...BASE_ENV, npm_config_cache: '/tmp/pm/npm' },
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.stdoutTail).toContain('cache=/tmp/pm/npm');
    expect(result.stdoutTail).toContain(dir);
    expect(result.stderrTail).toContain('oops');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a non-zero exit code without throwing — the caller owns the policy', async () => {
    const result = await runBootstrap({
      worktreeDir: dir,
      command: 'echo broken >&2; exit 3',
      env: BASE_ENV,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain('broken');
  });

  it('caps a chatty command to a rolling tail instead of failing on buffer size', async () => {
    const result = await runBootstrap({
      worktreeDir: dir,
      // ~200KB of output — execFile's default maxBuffer would kill this.
      command: 'i=0; while [ $i -lt 2000 ]; do echo "line $i is one hundred bytes of padding xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; echo LAST',
      env: BASE_ENV,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail.length).toBeLessThanOrEqual(BOOTSTRAP_TAIL_BYTES);
    expect(result.stdoutTail).toContain('LAST');
  });

  it('hang-breaker kills the whole group, including a backgrounded descendant', async () => {
    const marker = join(dir, 'survivor.txt');
    const result = await runBootstrap({
      worktreeDir: dir,
      // The backgrounded subshell would outlive a leader-only kill and write
      // the marker; a group SIGKILL must take it down too.
      command: `( sleep 3 && echo alive > ${marker} ) & sleep 30`,
      env: BASE_ENV,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
    // Give a hypothetical survivor time to prove itself, then assert it died.
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it('the run AbortSignal stops the command mid-flight', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort('timeout'), 200);
    const result = await runBootstrap({
      worktreeDir: dir,
      command: 'sleep 30',
      env: BASE_ENV,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 15_000);

  it('an already-aborted signal kills immediately', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const result = await runBootstrap({
      worktreeDir: dir,
      command: 'sleep 30',
      env: BASE_ENV,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  }, 15_000);
});

describe('dirtyGuard (feature 035)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brigadir-dirty-guard-'));
    await initRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('clean tree: reports nothing, reverts nothing', async () => {
    const result = await dirtyGuard(dir);
    expect(result.found).toEqual({ modified: [], untracked: [] });
    expect(result.reverted).toEqual([]);
    expect(result.residual).toEqual({ modified: [], untracked: [] });
  });

  it('reverts a tracked modification back to the committed content', async () => {
    await writeFile(join(dir, 'tracked.txt'), 'mutated by npm ci\n');
    const result = await dirtyGuard(dir);
    expect(result.found.modified).toEqual(['tracked.txt']);
    expect(result.reverted).toEqual(['tracked.txt']);
    expect(result.residual.modified).toEqual([]);
    expect(await readFile(join(dir, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('leaves untracked files in place and only reports them', async () => {
    await writeFile(join(dir, 'generated.log'), 'bootstrap output\n');
    const result = await dirtyGuard(dir);
    expect(result.found.untracked).toEqual(['generated.log']);
    expect(result.reverted).toEqual([]);
    expect(existsSync(join(dir, 'generated.log'))).toBe(true);
  });

  it('reports honest residue when the revert cannot clean everything', async () => {
    // A STAGED modification survives `git checkout -- .` (worktree-only) — the
    // guard must not claim the tree came out clean.
    await writeFile(join(dir, 'tracked.txt'), 'staged mutation\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: dir });
    const result = await dirtyGuard(dir);
    expect(result.found.modified).toEqual(['tracked.txt']);
    expect(result.residual.modified).toEqual(['tracked.txt']);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit, ensureCachedClone, GitError } from './clone-cache';

const USER = ['-c', 'user.email=t@test', '-c', 'user.name=Test'];

describe('ensureCachedClone (real local git)', () => {
  let root: string;
  let origin: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-clone-cache-'));
    origin = join(root, 'origin.git');
    const work = join(root, 'work');
    await execGit(['init', '--bare', '-b', 'main', origin]);
    await execGit(['clone', origin, work]);
    await mkdir(join(work, 'roles'), { recursive: true });
    await writeFile(join(work, 'roles', 'developer.md'), '---\nrole: Developer\n---\nv1 body');
    await execGit(['-C', work, ...USER, 'add', '-A']);
    await execGit(['-C', work, ...USER, 'commit', '-m', 'init']);
    await execGit(['-C', work, 'tag', 'v1']);
    await execGit(['-C', work, 'push', 'origin', 'main', '--tags']);
    // A second commit so main differs from tag v1.
    await writeFile(join(work, 'roles', 'developer.md'), '---\nrole: Developer\n---\nv2 body');
    await execGit(['-C', work, ...USER, 'commit', '-am', 'v2']);
    await execGit(['-C', work, 'push', 'origin', 'main']);
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('clones a fresh cache and checks out the default branch tip', async () => {
    const cache = join(root, 'c1');
    await ensureCachedClone({ url: origin, cacheDir: cache });
    const body = await readFile(join(cache, 'roles', 'developer.md'), 'utf8');
    expect(body).toContain('v2 body');
  });

  it('reuses (fetches) an existing healthy cache', async () => {
    const cache = join(root, 'c2');
    await ensureCachedClone({ url: origin, cacheDir: cache });
    // second call must not throw and must still resolve the files
    await ensureCachedClone({ url: origin, cacheDir: cache });
    expect((await readFile(join(cache, 'roles', 'developer.md'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('self-heals a corrupt cache by re-cloning', async () => {
    const cache = join(root, 'c3');
    await ensureCachedClone({ url: origin, cacheDir: cache });
    await rm(join(cache, '.git'), { recursive: true, force: true }); // gut it
    await ensureCachedClone({ url: origin, cacheDir: cache });
    expect(await readFile(join(cache, 'roles', 'developer.md'), 'utf8')).toContain('v2');
  });

  it('checks out a pinned ref (tag)', async () => {
    const cache = join(root, 'c4');
    await ensureCachedClone({ url: origin, cacheDir: cache, ref: 'v1' });
    expect(await readFile(join(cache, 'roles', 'developer.md'), 'utf8')).toContain('v1 body');
  });

  it('throws GitError for a missing ref', async () => {
    const cache = join(root, 'c5');
    await expect(
      ensureCachedClone({ url: origin, cacheDir: cache, ref: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(GitError);
  });
});

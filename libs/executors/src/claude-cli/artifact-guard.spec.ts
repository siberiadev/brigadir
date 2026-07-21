import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkMcpServerArtifact,
  formatArtifactGuardError,
  createMemoizedArtifactGuard,
} from './artifact-guard';

/**
 * Feature 026 (US2) — deployment guard decision logic. Pure fs mtime
 * comparison against scratch entry/src trees; env-override + memo behavior.
 */
describe('artifact guard (feature 026, US2)', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    delete process.env.BRIGADIR_MCP_SERVER_ENTRY;
    delete process.env.BRIGADIR_MCP_SERVER_SRC;
  });

  async function scratch(): Promise<{ entryPath: string; srcDir: string }> {
    root = await mkdtemp(join(tmpdir(), 'brigadir-guard-'));
    const srcDir = join(root, 'src');
    await mkdir(srcDir, { recursive: true });
    return { entryPath: join(root, 'dist', 'main.js'), srcDir };
  }

  /** Set mtime (and atime) to an absolute ms timestamp. */
  async function touchAt(path: string, ms: number): Promise<void> {
    await utimes(path, new Date(ms), new Date(ms));
  }

  it('missing entry → { ok:false, reason:"missing" }', async () => {
    const { entryPath, srcDir } = await scratch();
    await writeFile(join(srcDir, 'a.ts'), 'x');
    const verdict = await checkMcpServerArtifact({ entryPath, srcDir });
    expect(verdict).toMatchObject({ ok: false, reason: 'missing', entryPath });
  });

  it('entry older than the newest (nested) source → stale, with both mtimes', async () => {
    const { entryPath, srcDir } = await scratch();
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(entryPath, 'built');
    await mkdir(join(srcDir, 'nested'), { recursive: true });
    const newestSrc = join(srcDir, 'nested', 'deep.ts');
    await writeFile(join(srcDir, 'a.ts'), 'x');
    await writeFile(newestSrc, 'y');

    await touchAt(entryPath, 1_000_000);
    await touchAt(join(srcDir, 'a.ts'), 900_000);
    await touchAt(newestSrc, 2_000_000); // newer than the artifact

    const verdict = await checkMcpServerArtifact({ entryPath, srcDir });
    expect(verdict).toMatchObject({
      ok: false,
      reason: 'stale',
      entryPath,
      entryMtimeMs: 1_000_000,
      newestSrcPath: newestSrc,
      newestSrcMtimeMs: 2_000_000,
    });
  });

  it('entry newer than every source → ok', async () => {
    const { entryPath, srcDir } = await scratch();
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(entryPath, 'built');
    await writeFile(join(srcDir, 'a.ts'), 'x');
    await touchAt(join(srcDir, 'a.ts'), 1_000_000);
    await touchAt(entryPath, 2_000_000);

    expect(await checkMcpServerArtifact({ entryPath, srcDir })).toEqual({ ok: true });
  });

  it('absent source dir → existence-only pass (skipped: no-src-dir)', async () => {
    const { entryPath } = await scratch();
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(entryPath, 'built');
    const verdict = await checkMcpServerArtifact({ entryPath, srcDir: join(root, 'does-not-exist') });
    expect(verdict).toEqual({ ok: true, skipped: 'no-src-dir' });
  });

  it('formatArtifactGuardError names the artifact and the remedy', async () => {
    const missing = formatArtifactGuardError({ ok: false, reason: 'missing', entryPath: '/x/dist/main.js' });
    expect(missing).toContain('/x/dist/main.js');
    expect(missing).toContain('pnpm build:mcp-server');
    const stale = formatArtifactGuardError({
      ok: false,
      reason: 'stale',
      entryPath: '/x/dist/main.js',
      entryMtimeMs: 1_000_000,
      newestSrcPath: '/x/src/a.ts',
      newestSrcMtimeMs: 2_000_000,
    });
    expect(stale).toContain('/x/src/a.ts');
    expect(stale).toContain('STALE');
  });

  it('memoized guard re-evaluates only after its TTL (heal without restart)', async () => {
    const { entryPath, srcDir } = await scratch();
    await writeFile(join(srcDir, 'a.ts'), 'x'); // no artifact yet → missing
    process.env.BRIGADIR_MCP_SERVER_ENTRY = entryPath;
    process.env.BRIGADIR_MCP_SERVER_SRC = srcDir;

    const guard = createMemoizedArtifactGuard(1000);
    const first = await guard.check(0);
    expect(first.ok).toBe(false);

    // Build a fresh artifact, but within the TTL the cached (missing) verdict holds.
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(entryPath, 'built');
    await touchAt(join(srcDir, 'a.ts'), 1_000);
    await touchAt(entryPath, 5_000);
    expect((await guard.check(500)).ok).toBe(false); // still cached

    // Past the TTL it re-stats and sees the fresh artifact.
    expect((await guard.check(1500)).ok).toBe(true);
  });
});

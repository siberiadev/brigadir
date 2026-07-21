import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  channelBreadcrumbDirPath,
  channelBreadcrumbFilePath,
  claimChannelBreadcrumbFile,
  consumeClaimedBreadcrumbs,
  listChannelBreadcrumbFiles,
  listOrphanedClaims,
  readClaimedBreadcrumbs,
} from './channel-breadcrumbs';

const VALID_LINE = JSON.stringify({
  ts: '2026-07-21T12:34:56.789Z',
  tool: 'report_progress',
  kind: 'network',
  attempts: 11,
  error: { name: 'TypeError', message: 'fetch failed' },
  target: '127.0.0.1:3210',
});

describe('channel-breadcrumbs reader helpers (027 US3)', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setup(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'brigadir-channel-reader-'));
    await mkdir(channelBreadcrumbDirPath(root), { recursive: true });
    return root;
  }

  it('exactly one of two concurrent claims wins (rename race)', async () => {
    const configRoot = await setup();
    const file = channelBreadcrumbFilePath(configRoot, 'run-1');
    await writeFile(file, `${VALID_LINE}\n`);

    const [a, b] = await Promise.all([
      claimChannelBreadcrumbFile(file),
      claimChannelBreadcrumbFile(file),
    ]);
    const winners = [a, b].filter((x): x is string => x !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toBe(`${file}.ingesting`);

    // Проигравший второй заход по тому же пути — тоже no-op.
    expect(await claimChannelBreadcrumbFile(file)).toBeNull();
  });

  it('reads valid lines, drops invalid JSON and schema-violating lines', async () => {
    const configRoot = await setup();
    const file = channelBreadcrumbFilePath(configRoot, 'run-1');
    const badJson = '{not json';
    const badSchema = JSON.stringify({ ts: 'x', tool: '', kind: 'dns' });
    await writeFile(file, `${VALID_LINE}\n${badJson}\n${badSchema}\n\n${VALID_LINE}\n`);

    const claimed = await claimChannelBreadcrumbFile(file);
    const { records, invalidLines } = await readClaimedBreadcrumbs(claimed!);
    expect(records).toHaveLength(2);
    expect(invalidLines).toBe(2);
    expect(records[0]).toMatchObject({ tool: 'report_progress', attempts: 11 });
  });

  it('listing separates unclaimed files from orphaned claims; consume is best-effort', async () => {
    const configRoot = await setup();
    const runId = '3f60c1a1-0000-4000-8000-000000000000';
    await writeFile(channelBreadcrumbFilePath(configRoot, runId), `${VALID_LINE}\n`);
    await writeFile(`${channelBreadcrumbFilePath(configRoot, 'dead-claim')}.ingesting`, 'x\n');
    await writeFile(join(channelBreadcrumbDirPath(configRoot), 'junk.txt'), 'x');

    const files = await listChannelBreadcrumbFiles(configRoot);
    expect(files.map((f) => f.runId)).toEqual([runId]);
    expect(files[0].mtimeMs).toBeGreaterThan(0);

    const claims = await listOrphanedClaims(configRoot);
    expect(claims.map((c) => c.runId)).toEqual(['dead-claim']);

    await consumeClaimedBreadcrumbs(claims[0].filePath);
    await consumeClaimedBreadcrumbs(claims[0].filePath); // idempotent, never throws
    expect((await readdir(channelBreadcrumbDirPath(configRoot))).sort()).toEqual([
      `${runId}.jsonl`,
      'junk.txt',
    ]);
  });

  it('missing directory yields empty scans and null claims (never throws)', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-channel-empty-'));
    expect(await listChannelBreadcrumbFiles(root)).toEqual([]);
    expect(await listOrphanedClaims(root)).toEqual([]);
    expect(await claimChannelBreadcrumbFile(channelBreadcrumbFilePath(root, 'run-1'))).toBeNull();
    expect(await readClaimedBreadcrumbs(channelBreadcrumbFilePath(root, 'nope'))).toEqual({
      records: [],
      invalidLines: 0,
    });
  });
});

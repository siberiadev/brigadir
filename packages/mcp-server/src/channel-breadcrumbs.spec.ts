import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_BREADCRUMB_FILE_BYTES,
  appendChannelBreadcrumb,
  channelBreadcrumbFilePath,
  type ChannelBreadcrumbRecord,
} from './channel-breadcrumbs';

const RECORD: ChannelBreadcrumbRecord = {
  ts: '2026-07-21T12:34:56.789Z',
  tool: 'report_progress',
  kind: 'network',
  attempts: 11,
  error: { name: 'TypeError', message: 'fetch failed' },
  target: '127.0.0.1:3210',
};

/**
 * Ключи контракта (ChannelBreadcrumbRecordSchema, @brigadir/contracts).
 * mcp-server остаётся dependency-free — форма пиннится этим фикстур-тестом.
 */
const CONTRACT_KEYS = ['ts', 'tool', 'kind', 'attempts', 'error', 'target'];

describe('appendChannelBreadcrumb (027 US3)', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup() {
    tmpDir = await mkdtemp(join(tmpdir(), 'brigadir-mcp-channel-'));
    return join(tmpDir, 'run.marker');
  }

  it('appends one JSONL line per exhaustion matching the contract shape', async () => {
    const markerPath = await setup();
    await appendChannelBreadcrumb(markerPath, 'run-1', RECORD);
    await appendChannelBreadcrumb(markerPath, 'run-1', {
      ...RECORD,
      tool: 'complete_task',
      kind: 'http',
      attempts: 4,
      status: 502,
      error: { name: 'HTTPError', message: 'HTTP 502' },
    });

    const file = channelBreadcrumbFilePath(markerPath, 'run-1');
    expect(file).toBe(join(dirname(markerPath), '.brigadir-channel', 'run-1.jsonl'));
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    for (const key of CONTRACT_KEYS) expect(first).toHaveProperty(key);
    expect(first).toMatchObject({ tool: 'report_progress', kind: 'network', attempts: 11 });
    // target — только host:port, без путей/схемы.
    expect(first.target).toBe('127.0.0.1:3210');

    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(second).toMatchObject({ kind: 'http', status: 502, attempts: 4 });
  });

  it('never throws when the directory is unwritable (best-effort posture)', async () => {
    const markerPath = await setup();
    const dir = join(dirname(markerPath), '.brigadir-channel');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o444);
    try {
      await expect(appendChannelBreadcrumb(markerPath, 'run-1', RECORD)).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('skips appends once the file exceeds the volume cap', async () => {
    const markerPath = await setup();
    const file = channelBreadcrumbFilePath(markerPath, 'run-1');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'x'.repeat(MAX_BREADCRUMB_FILE_BYTES));

    await appendChannelBreadcrumb(markerPath, 'run-1', RECORD);
    const content = await readFile(file, 'utf8');
    expect(content).toHaveLength(MAX_BREADCRUMB_FILE_BYTES); // ничего не дописано
  });
});

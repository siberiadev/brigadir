import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outboxFilePath, readOutboxReport, consumeOutbox, listOutboxEntries } from './outbox';

describe('outbox (Phase 4 — durable finalize reconcile)', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seed(runId: string, contents: unknown): Promise<void> {
    const file = outboxFilePath(root, runId);
    await mkdir(join(root, '.brigadir-outbox'), { recursive: true });
    await writeFile(file, JSON.stringify(contents));
  }

  it('outboxFilePath places <runId>.json under .brigadir-outbox', () => {
    root = '/tmp/cfg-root';
    expect(outboxFilePath(root, 'run-1')).toBe('/tmp/cfg-root/.brigadir-outbox/run-1.json');
  });

  it('readOutboxReport returns the report for a matching file', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    const report = { schema_version: 1, outcome: 'success', summary: 'done', checks: [] };
    await seed('run-1', { runId: 'run-1', outcome: 'success', report, timestamp: 't' });

    expect(await readOutboxReport(root, 'run-1')).toEqual(report);
  });

  it('readOutboxReport returns null when the file is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    expect(await readOutboxReport(root, 'run-1')).toBeNull();
  });

  it('readOutboxReport returns null on malformed JSON', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    await mkdir(join(root, '.brigadir-outbox'), { recursive: true });
    await writeFile(outboxFilePath(root, 'run-1'), '{not json');

    expect(await readOutboxReport(root, 'run-1')).toBeNull();
  });

  it('readOutboxReport returns null on a runId mismatch (stale/foreign file)', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    await seed('run-1', { runId: 'other-run', report: { outcome: 'success' }, timestamp: 't' });

    expect(await readOutboxReport(root, 'run-1')).toBeNull();
  });

  it('consumeOutbox deletes the file and is a no-op when absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    await seed('run-1', { runId: 'run-1', report: { outcome: 'success' }, timestamp: 't' });

    await consumeOutbox(root, 'run-1');
    expect(await readOutboxReport(root, 'run-1')).toBeNull();
    // Idempotent — a second consume must not throw.
    await expect(consumeOutbox(root, 'run-1')).resolves.toBeUndefined();
  });

  // --- feature 026 (US3): listOutboxEntries for the periodic reconciler ---

  it('listOutboxEntries returns [] when the outbox dir is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    expect(await listOutboxEntries(root)).toEqual([]);
  });

  it('listOutboxEntries returns one entry per *.json, ignoring other files and subdirs', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-outbox-test-'));
    await seed('run-a', { runId: 'run-a', report: {}, timestamp: 't' });
    await seed('run-b', { runId: 'run-b', report: {}, timestamp: 't' });
    // Noise that must be ignored: a non-json file and a nested subdirectory.
    await writeFile(join(root, '.brigadir-outbox', 'notes.txt'), 'ignore me');
    await mkdir(join(root, '.brigadir-outbox', 'sub'), { recursive: true });

    const entries = await listOutboxEntries(root);
    const byId = Object.fromEntries(entries.map((e) => [e.runId, e]));
    expect(Object.keys(byId).sort()).toEqual(['run-a', 'run-b']);
    expect(byId['run-a'].filePath).toBe(outboxFilePath(root, 'run-a'));
    expect(typeof byId['run-a'].mtimeMs).toBe('number');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { Worker } from 'bullmq';
import type { BrigadirDb } from '@brigadir/database';
import { applyExecutorConcurrency } from './executor-concurrency';

function fakeDb(total: number | null): BrigadirDb {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(total === null ? [] : [{ total }]),
  };
  return { select: () => chain } as unknown as BrigadirDb;
}

const logger = { log: vi.fn() } as unknown as Logger;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('applyExecutorConcurrency (executors.max_parallel_runs → live worker)', () => {
  it('applies the summed DB limit over the decorator default', async () => {
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(1), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(1);
  });

  it('sums multiple executors of one type (subscription + team runner)', async () => {
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(5), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(5);
  });

  it('no executor rows → decorator default stands', async () => {
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(null), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(2);
  });

  it('sum of zero (or null) never sets a non-positive concurrency', async () => {
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(0), worker, 'mock', logger);
    expect(worker.concurrency).toBe(2);
  });
});

describe('applyExecutorConcurrency — EXECUTOR_MAX_TYPE_CONCURRENCY ceiling (Phase 5)', () => {
  it('clamps a high summed capacity to the generic ceiling and logs the clamp', async () => {
    vi.stubEnv('EXECUTOR_MAX_TYPE_CONCURRENCY', '6');
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(22), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(6);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('clamped by EXECUTOR_MAX_TYPE_CONCURRENCY=6'));
  });

  it('unset ceiling → pure summed behavior preserved', async () => {
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(22), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(22);
  });

  it('per-type ceiling wins over the generic one', async () => {
    vi.stubEnv('EXECUTOR_MAX_TYPE_CONCURRENCY', '10');
    vi.stubEnv('EXECUTOR_MAX_TYPE_CONCURRENCY_CLAUDE_CLI', '4');
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(22), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(4);
  });

  it('ceiling above the sum does not clamp (no false log)', async () => {
    vi.stubEnv('EXECUTOR_MAX_TYPE_CONCURRENCY', '50');
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(22), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(22);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("sum of enabled profiles'"));
  });

  it.each(['0', '-1', 'abc', '3.5', ''])('invalid ceiling %j is ignored → pure sum', async (raw) => {
    vi.stubEnv('EXECUTOR_MAX_TYPE_CONCURRENCY', raw);
    const worker = { concurrency: 2 } as Worker;
    await applyExecutorConcurrency(fakeDb(22), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(22);
  });

  it('quiet no-op preserved when the clamped value is unchanged', async () => {
    vi.stubEnv('EXECUTOR_MAX_TYPE_CONCURRENCY', '6');
    const worker = { concurrency: 6 } as Worker;
    await applyExecutorConcurrency(fakeDb(22), worker, 'claude_cli', logger);
    expect(worker.concurrency).toBe(6);
    expect(logger.log).not.toHaveBeenCalled();
  });
});

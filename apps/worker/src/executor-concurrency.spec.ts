import { describe, it, expect, vi } from 'vitest';
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

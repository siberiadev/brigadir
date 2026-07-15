import { describe, it, expect } from 'vitest';
import { RunsService } from './runs.service';

function fakeDb(currentStatus: string, captured: { set?: unknown } = {}): unknown {
  return {
    update: () => ({
      set: (vals: unknown) => {
        captured.set = vals;
        return {
          where: () => ({
            returning: async () => (currentStatus === 'running' ? [{ id: 'run-1' }] : []),
          }),
        };
      },
    }),
  };
}

describe('RunsService.failIfStillRunning (T102, D7)', () => {
  it('flips a running run to failed with the diagnostic', async () => {
    const captured: { set?: unknown } = {};
    const service = new RunsService(fakeDb('running', captured) as never);
    const flipped = await service.failIfStillRunning('run-1', 'no callback received');
    expect(flipped).toBe(true);
    expect(captured.set).toMatchObject({ status: 'failed', error: 'no callback received' });
  });

  it('is a no-op when the run is awaiting_human (legitimate park — D7 no-clobber)', async () => {
    const service = new RunsService(fakeDb('awaiting_human') as never);
    await expect(service.failIfStillRunning('run-1', 'diag')).resolves.toBe(false);
  });

  it('is a no-op when the run is already succeeded', async () => {
    const service = new RunsService(fakeDb('succeeded') as never);
    await expect(service.failIfStillRunning('run-1', 'diag')).resolves.toBe(false);
  });

  it('is a no-op when the run is superseded', async () => {
    const service = new RunsService(fakeDb('superseded') as never);
    await expect(service.failIfStillRunning('run-1', 'diag')).resolves.toBe(false);
  });
});

describe('RunsService.recordCostUsage', () => {
  function costFakeDb(captured: { sets: unknown[] }, opts: { throwOnUpdate?: boolean } = {}): unknown {
    return {
      update: () => ({
        set: (vals: unknown) => {
          captured.sets.push(vals);
          return {
            where: async () => {
              if (opts.throwOnUpdate) throw new Error('db down');
            },
          };
        },
      }),
    };
  }

  it('writes cost_usd as a string and usage, without touching status', async () => {
    const captured = { sets: [] as unknown[] };
    const service = new RunsService(costFakeDb(captured) as never);
    await service.recordCostUsage('run-1', { costUsd: 0.0123, usage: { input_tokens: 12 } });
    expect(captured.sets).toHaveLength(1);
    expect(captured.sets[0]).toEqual({ costUsd: '0.0123', usage: { input_tokens: 12 } });
    expect(captured.sets[0]).not.toHaveProperty('status');
  });

  it('writes only the defined field — never nulls out the other', async () => {
    const captured = { sets: [] as unknown[] };
    const service = new RunsService(costFakeDb(captured) as never);
    await service.recordCostUsage('run-1', { costUsd: 0.5 });
    expect(captured.sets[0]).toEqual({ costUsd: '0.5' });
    expect(captured.sets[0]).not.toHaveProperty('usage');
  });

  it('is a no-op (no UPDATE issued) when both values are undefined', async () => {
    const captured = { sets: [] as unknown[] };
    const service = new RunsService(costFakeDb(captured) as never);
    await service.recordCostUsage('run-1', {});
    expect(captured.sets).toHaveLength(0);
  });

  it('never throws — a DB error is swallowed and logged (best-effort contract)', async () => {
    const captured = { sets: [] as unknown[] };
    const service = new RunsService(costFakeDb(captured, { throwOnUpdate: true }) as never);
    await expect(service.recordCostUsage('run-1', { costUsd: 0.1 })).resolves.toBeUndefined();
  });
});

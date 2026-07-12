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

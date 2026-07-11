import { describe, it, expect, vi } from 'vitest';
import { RunTriggerService } from './run-trigger.service';

/**
 * T019 unit: asserts the enqueue payload + options shape. The DB and queue are
 * stubbed; the full path is proven end-to-end in T021 (dedup.spec.ts).
 */

interface QueryStub {
  from: () => QueryStub;
  where: () => QueryStub;
  limit: () => Promise<unknown[]>;
}

function selectStub(rows: unknown[]): QueryStub {
  const stub: QueryStub = {
    from: () => stub,
    where: () => stub,
    limit: () => Promise.resolve(rows),
  };
  return stub;
}

describe('RunTriggerService.trigger — payload shape (T019)', () => {
  it('inserts a queued run and enqueues { runId } with dedup + attempts + custom backoff', async () => {
    const agentRow = {
      id: 'agent-1',
      workspaceId: 'ws-1',
      executorId: 'exec-1',
      maxAttempts: 3,
    };
    const executorRow = { type: 'mock' };

    const selectCalls = [selectStub([agentRow]), selectStub([executorRow])];
    const db = {
      select: vi.fn(() => selectCalls.shift()),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: 'run-1' }]),
        }),
      }),
    };

    const add = vi.fn(() => Promise.resolve({ id: 'job-1' }));
    const moduleRef = { get: vi.fn(() => ({ add })) };

    const service = new RunTriggerService(
      db as never,
      moduleRef as never,
    );

    const result = await service.trigger({
      ticketId: 'ticket-1',
      agentId: 'agent-1',
      triggerEvent: { source: 'manual', mock_scenario: 'success' },
    });

    expect(result).toEqual({ deduplicated: false, runId: 'run-1' });
    expect(add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = add.mock.calls[0];
    expect(jobName).toBe('run');
    expect(payload).toEqual({ runId: 'run-1' });
    expect(opts).toMatchObject({
      deduplication: { id: 'ticket-1:agent-1' },
      attempts: 3,
      backoff: { type: 'custom' },
    });
  });

  it('returns deduplicated on a 23505 unique violation without enqueuing', async () => {
    const agentRow = { id: 'a', workspaceId: 'ws', executorId: 'e', maxAttempts: 2 };
    const executorRow = { type: 'mock' };
    const selectCalls = [
      selectStub([agentRow]),
      selectStub([executorRow]),
      selectStub([{ id: 'existing-run' }]),
    ];
    const db = {
      select: vi.fn(() => selectCalls.shift()),
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
        }),
      }),
    };
    const add = vi.fn();
    const moduleRef = { get: vi.fn(() => ({ add })) };

    const service = new RunTriggerService(db as never, moduleRef as never);
    const result = await service.trigger({ ticketId: 'ticket-1', agentId: 'a' });

    expect(result).toEqual({ deduplicated: true, existingRunId: 'existing-run' });
    expect(add).not.toHaveBeenCalled();
  });
});

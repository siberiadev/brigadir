import { describe, it, expect } from 'vitest';
import { RUN_QUEUE_EXECUTOR_TYPES } from '@brigadir/contracts';
import { runQueueName, RECONCILE_QUEUE, OUTBOX_RECONCILE_QUEUE } from './queue.constants';

/**
 * T129 — the provisioned queue set is derived from the fixed
 * RUN_QUEUE_EXECUTOR_TYPES registry, not from yaml/agents contents. This is the
 * static structure QueuesModule.register() reads at composition time.
 */
describe('run-queue registry (T129)', () => {
  it('provisions run.mock + run.claude_cli + run.kimi + reconcile + outbox-reconcile, independent of any config', () => {
    // feature 026 (US3): the outbox-reconcile scheduler queue is another fixed
    // composition-time constant.
    const queues = [...RUN_QUEUE_EXECUTOR_TYPES.map(runQueueName), RECONCILE_QUEUE, OUTBOX_RECONCILE_QUEUE];
    expect(new Set(queues)).toEqual(
      new Set(['run.mock', 'run.claude_cli', 'run.kimi', 'reconcile', 'outbox-reconcile']),
    );
  });
});

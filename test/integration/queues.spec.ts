import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QueuesModule, runQueueName, RECONCILE_QUEUE } from '@brigadir/queues';
import { startRedis, RedisHarness } from './harness';
import { join } from 'node:path';

/**
 * T018: the queue registry stands up `run.mock` + `reconcile` against a real
 * Redis container from the loaded config.
 */
describe('queue registry (T018)', () => {
  let redis: RedisHarness;

  beforeAll(async () => {
    redis = await startRedis();
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
  }, 180_000);

  afterAll(async () => {
    await redis?.stop();
  });

  it('registers run.mock and reconcile queues', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [QueuesModule.register()],
    }).compile();

    const runQueue = moduleRef.get<Queue>(getQueueToken(runQueueName('mock')), { strict: false });
    const reconcileQueue = moduleRef.get<Queue>(getQueueToken(RECONCILE_QUEUE), { strict: false });

    expect(runQueue.name).toBe('run.mock');
    expect(reconcileQueue.name).toBe('reconcile');

    await moduleRef.close();
  });
});

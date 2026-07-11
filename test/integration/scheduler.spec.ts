import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RECONCILE_QUEUE } from '@brigadir/queues';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { join } from 'node:path';

/**
 * T020: booting the worker context twice upserts exactly ONE reconcile
 * scheduler (upsert idempotency — spec FR-010).
 */
describe('reconcile scheduler idempotency (T020)', () => {
  let db: DbHarness;
  let redis: RedisHarness;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
  }, 240_000);

  afterAll(async () => {
    await db?.stop();
    await redis?.stop();
  });

  async function bootWorkerOnce(): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerAppModule],
    }).compile();
    // init() fires OnApplicationBootstrap (where the scheduler upserts).
    await moduleRef.init();
    await moduleRef.close();
  }

  it('has exactly one reconcile scheduler after two boots', async () => {
    await bootWorkerOnce();
    await bootWorkerOnce();

    // Inspect schedulers via a throwaway module holding the reconcile queue.
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerAppModule],
    }).compile();
    const queue = moduleRef.get<Queue>(getQueueToken(RECONCILE_QUEUE), { strict: false });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0].key).toContain('reconcile');
    await moduleRef.close();
  });
});

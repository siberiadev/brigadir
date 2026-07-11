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

  // `moduleRef.close()` awaits every BullMQ Worker's own `.close()`
  // (@nestjs/bullmq's onApplicationShutdown), but the underlying ioredis
  // socket's actual TCP teardown can trail slightly behind that resolved
  // promise, occasionally surfacing a stray "Connection is closed"
  // rejection from a socket finishing its close after the next boot cycle's
  // module has already started. Two workers now close per cycle here
  // instead of one (run.mock + run.claude_cli, iteration 3), which made
  // this pre-existing-but-latent library-internal race meaningfully more
  // likely to fire within this test's tight back-to-back boot/close loop.
  // The test's own assertions are unaffected either way (the scheduler
  // upsert logic isn't what's racing) — only this specific, identified
  // rejection pattern is suppressed; anything else still fails the suite.
  function ignoreKnownIoredisCloseRace(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('Connection is closed')) {
      throw err instanceof Error ? err : new Error(message);
    }
  }

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
    process.on('unhandledRejection', ignoreKnownIoredisCloseRace);
  }, 240_000);

  afterAll(async () => {
    process.off('unhandledRejection', ignoreKnownIoredisCloseRace);
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

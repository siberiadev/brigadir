import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';

/**
 * T015 (US4, FR-025/SC-008): with live workers, updating
 * `executors.concurrency_limit` re-applies to the running `Worker.concurrency`
 * for that type within the re-apply interval — no restart. Multiple executors
 * of a type ⇒ the applied concurrency is their SUM.
 */
describe('live concurrency re-apply (T015)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let mockProc: RunProcessor;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    // Fast re-apply cadence so the test doesn't wait ~15 s.
    process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS = '120';

    // Executors are platform-scoped (migration 0003) — no workspace needed.
    // One mock executor, concurrency 2 (matches the decorator default → no-op at boot).
    await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'm1', concurrencyLimit: 2, config: {} });

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    mockProc = worker.get(RunProcessor, { strict: false });
  }, 240_000);

  afterAll(async () => {
    delete process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS;
    await worker?.close();
    await db?.stop();
    await redis?.stop();
  });

  /** Poll the live worker's concurrency until it reaches `expected` (or time out). */
  async function waitForConcurrency(expected: number, timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mockProc.worker.concurrency === expected) return expected;
      await new Promise((r) => setTimeout(r, 40));
    }
    return mockProc.worker.concurrency;
  }

  it('a concurrency_limit edit re-applies to the live worker with no restart', async () => {
    expect(mockProc.worker.concurrency).toBe(2);
    await db.db
      .update(schema.executors)
      .set({ concurrencyLimit: 4 })
      .where(eq(schema.executors.name, 'm1'));
    expect(await waitForConcurrency(4)).toBe(4);
  });

  it('multiple executors of a type ⇒ the applied concurrency is their sum', async () => {
    // m1 is now 4; add m2 = 3 → sum 7.
    await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'm2', concurrencyLimit: 3, config: {} });
    expect(await waitForConcurrency(7)).toBe(7);
  });
});

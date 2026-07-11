import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService, RunsService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { join } from 'node:path';

/**
 * T028 (US1): rate_limited re-queues without burning an attempt; the retry
 * succeeds. Then a second finalize of the terminal run changes 0 rows
 * (finalize idempotency + terminal immutability — data-model invariant 1).
 */
describe('rate-limit accounting + finalize idempotency (T028)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let runs: RunsService;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    // Readiness gate — do not start polling tests before the consumer is live
    // (slow Docker daemon late in a full run delays the connection past 60s).
    await worker.get(RunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
    runs = worker.get(RunsService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function statusOf(runId: string): Promise<{ status: string; attempt: number }> {
    const [row] = await db.db
      .select({ status: schema.runs.status, attempt: schema.runs.attempt })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    return row;
  }

  async function poll(runId: string, target: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await statusOf(runId);
      if (row?.status === target) return;
      if (Date.now() > deadline) throw new Error(`run ${runId} at ${row?.status}, want ${target}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('rate_limited does not consume an attempt and later succeeds', async () => {
    const p = await seedPipeline(db.db);
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'rate_limited', rate_limit_ttl_ms: 200 },
    });
    expect(res.deduplicated).toBe(false);
    const runId = res.deduplicated === false ? res.runId : '';

    await poll(runId, 'succeeded');
    const final = await statusOf(runId);
    expect(final.status).toBe('succeeded');
    // attempt stays 1 — the rate-limit re-queue did not burn an attempt.
    expect(final.attempt).toBe(1);
  });

  it('a second finalize of a terminal run changes nothing', async () => {
    const p = await seedPipeline(db.db);
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'success' },
    });
    const runId = res.deduplicated === false ? res.runId : '';
    await poll(runId, 'succeeded');

    // attempt to overwrite the terminal run → guarded UPDATE affects 0 rows.
    const changed = await runs.finalizeStatus(runId, 'failed', { error: 'should not apply' });
    expect(changed).toBe(false);

    const after = await statusOf(runId);
    expect(after.status).toBe('succeeded');
  });
});

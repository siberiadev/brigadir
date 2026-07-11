import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import type { MockScenario } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { join } from 'node:path';

/**
 * T027 (US1): every scenario reaches its expected status via the real worker;
 * needs_human creates exactly one open human_task; crash retries the same row
 * (attempt+1) then fails on exhaustion. Deterministic on rerun (SC-001).
 */
describe('six-scenario run lifecycle (T027)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init(); // starts BullMQ workers + reconcile scheduler
    // Readiness gate: under a loaded Docker daemon (10th container of a full
    // run) the consumer may connect seconds after init(); polling tests must
    // not start before the worker actually consumes.
    await worker.get(RunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function triggerScenario(scenario: MockScenario): Promise<string> {
    const p = await seedPipeline(db.db);
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: scenario, rate_limit_ttl_ms: 200 },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  async function pollRun(
    runId: string,
    until: (status: string) => boolean,
    timeoutMs = 60_000,
  ): Promise<{ status: string; attempt: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db
        .select({ status: schema.runs.status, attempt: schema.runs.attempt })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      if (row && until(row.status)) return row;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} stuck at ${row?.status} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const TERMINAL = (s: string): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(s);

  it('success → succeeded', async () => {
    const runId = await triggerScenario('success');
    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('succeeded');

    const checks = await db.db
      .select()
      .from(schema.runChecks)
      .where(eq(schema.runChecks.runId, runId));
    expect(checks.length).toBeGreaterThan(0);
  });

  it('failure → failed', async () => {
    const runId = await triggerScenario('failure');
    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('failed');
  });

  it('needs_human → awaiting_human + exactly one open human_task', async () => {
    const runId = await triggerScenario('needs_human');
    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('awaiting_human');

    const tasks = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, runId), eq(schema.humanTasks.status, 'open')));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe('question');
  });

  it('timeout → timed_out', async () => {
    const runId = await triggerScenario('timeout');
    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('timed_out');
  });

  it('crash → retries the same row (attempt+1) then fails on exhaustion', async () => {
    const runId = await triggerScenario('crash');
    const row = await pollRun(runId, (s) => s === 'failed', 90_000);
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(2); // seedPipeline maxAttempts = 2
  });

  it('rate_limited → succeeded after re-queue', async () => {
    const runId = await triggerScenario('rate_limited');
    const row = await pollRun(runId, (s) => s === 'succeeded', 60_000);
    expect(row.status).toBe('succeeded');
  });
});

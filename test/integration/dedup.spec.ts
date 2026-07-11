import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseModule, schema } from '@brigadir/database';
import { QueuesModule, runQueueName } from '@brigadir/queues';
import { RunsModule, RunTriggerService } from '@brigadir/runs';
import {
  startDatabase,
  startRedis,
  seedPipeline,
  DbHarness,
  RedisHarness,
  SeededPipeline,
} from './harness';
import { join } from 'node:path';

const ACTIVE = ['queued', 'running', 'awaiting_human'];

/**
 * T021 (US2): duplicate + concurrent triggers for the same (ticket, agent) yield
 * exactly one active run and one enqueued job; once the run is terminal a fresh
 * trigger creates a new run.
 */
describe('trigger dedup guarantee (T021)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let moduleRef: TestingModule;
  let trigger: RunTriggerService;
  let queue: Queue;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ databaseUrl: db.url }), QueuesModule.register(), RunsModule],
    }).compile();
    trigger = moduleRef.get(RunTriggerService);
    queue = moduleRef.get<Queue>(getQueueToken(runQueueName('mock')), { strict: false });
  }, 240_000);

  afterAll(async () => {
    await moduleRef?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function activeRuns(p: SeededPipeline): Promise<{ id: string }[]> {
    return db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, p.ticketId), inArray(schema.runs.status, ACTIVE)));
  }

  async function jobsFor(runId: string): Promise<number> {
    const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'paused', 'prioritized']);
    return jobs.filter((j) => (j.data as { runId?: string }).runId === runId).length;
  }

  it('(a) sequential duplicate → one active run, one job, second deduplicated', async () => {
    const p = await seedPipeline(db.db);
    const r1 = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'success' },
    });
    const r2 = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'success' },
    });

    expect(r1.deduplicated).toBe(false);
    expect(r2.deduplicated).toBe(true);
    if (!r1.deduplicated) {
      expect(await jobsFor(r1.runId)).toBe(1);
      if (r2.deduplicated) expect(r2.existingRunId).toBe(r1.runId);
    }
    expect(await activeRuns(p)).toHaveLength(1);
  });

  it('(b) N concurrent triggers → exactly one active run, one winner', async () => {
    const p = await seedPipeline(db.db);
    const N = 4;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        trigger.trigger({
          ticketId: p.ticketId,
          agentId: p.agentId,
          triggerEvent: { source: 'manual', mock_scenario: 'success' },
        }),
      ),
    );

    const winners = results.filter((r) => r.deduplicated === false);
    const losers = results.filter((r) => r.deduplicated === true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);
    expect(await activeRuns(p)).toHaveLength(1);
  });

  it('(c) after the run is terminal, a new trigger creates a new run', async () => {
    const p = await seedPipeline(db.db);
    const first = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'success' },
    });
    expect(first.deduplicated).toBe(false);
    const firstRunId = first.deduplicated === false ? first.runId : '';

    // finish the run
    await db.db
      .update(schema.runs)
      .set({ status: 'succeeded', finishedAt: sql`now()` })
      .where(eq(schema.runs.id, firstRunId));

    const second = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'success' },
    });
    expect(second.deduplicated).toBe(false);
    if (!second.deduplicated) {
      expect(second.runId).not.toBe(firstRunId);
    }

    const allRuns = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.ticketId, p.ticketId));
    expect(allRuns).toHaveLength(2);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { runQueueName } from '@brigadir/queues';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

/**
 * T088 (US5, SC-006): a subscription rate-limit signal from the CLI is
 * "retry later," never a failed attempt — the run stays active and its
 * attempt counter is not spent.
 */
describe('claude_cli rate limit (T088/US5)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function pollApiRetryEvent(
    runId: string,
    timeoutMs = 15_000,
  ): Promise<(typeof schema.runEvents.$inferSelect)[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.db
        .select()
        .from(schema.runEvents)
        .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'api_retry')));
      if (rows.length > 0) return rows;
      if (Date.now() > deadline) throw new Error(`no api_retry event for run ${runId} after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('rate limit: api_retry event recorded, run stays active, attempt not spent', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-rate-limit';

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env),
      behavior: { allowed_tools: ['Read'], branch_prefix: 'feat' },
      ticketKey: 'BRIG-900',
      maxAttempts: 2,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      // Fast test-controlled requeue TTL — same established precedent as
      // the mock scenario's own rate_limited test (scenarios.spec.ts).
      triggerEvent: { source: 'manual', rate_limit_ttl_ms: 200 },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const events = await pollApiRetryEvent(res.runId);
    expect(events[0].payload).toMatchObject({
      error: 'rate_limit',
      retry_delay_ms: 900000,
      attempt: 1,
    });

    // Give the requeue a brief window, then confirm the run is still active
    // (never finalized failed) and its attempt counter wasn't spent.
    await new Promise((r) => setTimeout(r, 500));
    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, res.runId)).limit(1);
    expect(['queued', 'running']).toContain(row.status);
    expect(row.attempt).toBe(1);

    // The fixture never stops signaling rate_limit, so left alone this job
    // would requeue forever — wipe it so it doesn't keep firing into (and
    // racing) this suite's own teardown.
    const queue = worker.get<Queue>(getQueueToken(runQueueName('claude_cli')), { strict: false });
    await queue.obliterate({ force: true });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { slugifyAgentKey } from '@brigadir/contracts';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { WorkerLockService, workerLockKey } from '../../apps/worker/src/worker-lock.service';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';

/**
 * Feature 027, US2 (FR-004 / SC-002): exclusive worker lock over the single
 * queue namespace. A second worker on the same prefix consumes nothing and is
 * loudly blocked; a released or expired lock hands over within a bounded time;
 * distinct prefixes stay fully independent (suite-isolation regression guard).
 */
describe('exclusive worker lock (027 US2)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let redisClient: Redis;

  const LOCK_TTL_MS = 3_000; // fast takeover in tests; renewal 1s, acquire cadence 1s

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    process.env.BRIGADIR_WORKER_LOCK_TTL_MS = String(LOCK_TTL_MS);
    redisClient = new Redis(redis.url);
  }, 240_000);

  afterAll(async () => {
    delete process.env.BRIGADIR_WORKER_LOCK_TTL_MS;
    delete process.env.BRIGADIR_WORKER_MODE;
    await redisClient?.quit();
    await db?.stop();
    await redis?.stop();
  });

  async function bootWorker(mode: string): Promise<TestingModule> {
    process.env.BRIGADIR_WORKER_MODE = mode;
    const moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  async function seedMockRun(trigger: RunTriggerService, ticketKey: string): Promise<string> {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: `lock-ws-${ticketKey}`,
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    const [executor] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: `lock-exec-${ticketKey}`, maxParallelRuns: 2, config: {} })
      .returning({ id: schema.executors.id });
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId: ws.id,
        executorId: executor.id,
        name: `lock-agent-${ticketKey}`,
        key: slugifyAgentKey(`lock-agent-${ticketKey}`),
        instruction: 'x',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: ws.id, jiraKey: ticketKey, jiraId: ticketKey, summary: 'lock' })
      .returning({ id: schema.tickets.id });

    const res = await trigger.trigger({
      ticketId: ticket.id,
      agentId: agent.id,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  async function runStatus(runId: string): Promise<string> {
    const [row] = await db.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    return row.status;
  }

  it(
    'second worker on the same prefix is blocked (consumes nothing) and both sides see it; handover after graceful shutdown',
    { timeout: 120_000 },
    async () => {
      const prefix = process.env.BULLMQ_PREFIX ?? 'bull';

      const workerA = await bootWorker('dev');
      const lockA = workerA.get(WorkerLockService);
      expect(lockA.state).toBe('held');

      const workerB = await bootWorker('agents');
      const lockB = workerB.get(WorkerLockService);
      const procB = workerB.get(RunProcessor);

      // (a) B is blocked: no consumption, holder identity visible on B's side.
      await waitFor(() => lockB.state === 'blocked', 10_000);
      expect(procB.worker.isRunning()).toBe(false);
      expect(lockB.lastSeenHolder?.mode).toBe('dev');

      // The contender key is visible to the holder (loud on BOTH sides).
      await waitFor(async () => {
        const raw = await redisClient.get(`${prefix}:worker-lock:contender`);
        return raw !== null && (JSON.parse(raw) as { mode: string }).mode === 'agents';
      }, 10_000);

      // A run enqueued now is processed by A (the holder), never by B.
      const triggerA = workerA.get(RunTriggerService);
      const runId = await seedMockRun(triggerA, 'LOCK-1');
      await waitFor(async () => (await runStatus(runId)) === 'succeeded', 30_000);
      expect(procB.worker.isRunning()).toBe(false);

      // (b) graceful shutdown of A → drain + release → B acquires and consumes.
      await workerA.close();
      await waitFor(() => lockB.state === 'held', 10_000);
      await waitFor(() => procB.worker.isRunning(), 10_000);

      const triggerB = workerB.get(RunTriggerService);
      const runId2 = await seedMockRun(triggerB, 'LOCK-2');
      await waitFor(async () => (await runStatus(runId2)) === 'succeeded', 30_000);

      await workerB.close();
      // Lock is released on close — key gone (or expiring), no owner remains.
      await waitFor(async () => (await redisClient.get(workerLockKey(prefix))) === null, 10_000);
    },
  );

  it(
    'dead holder without release → bounded takeover after TTL expiry',
    { timeout: 60_000 },
    async () => {
      const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
      // Simulate a holder that died uncleanly: foreign identity, finite PX.
      await redisClient.set(
        workerLockKey(prefix),
        JSON.stringify({
          mode: 'dev',
          pid: 999_999,
          hostname: 'dead-host',
          acquired_at: new Date().toISOString(),
        }),
        'PX',
        LOCK_TTL_MS,
      );

      const started = Date.now();
      const worker = await bootWorker('agents');
      const lock = worker.get(WorkerLockService);
      expect(lock.state).toBe('blocked');

      await waitFor(() => lock.state === 'held', LOCK_TTL_MS + 5_000);
      // Bounded: TTL + acquire cadence + slack, never minutes.
      expect(Date.now() - started).toBeLessThan(LOCK_TTL_MS + 5_000);
      await worker.close();
    },
  );

  it(
    'lock lost then re-acquired → consumption really resumes (regression 2026-07-28)',
    { timeout: 120_000 },
    async () => {
      const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
      const worker = await bootWorker('dev');
      const lock = worker.get(WorkerLockService);
      const proc = worker.get(RunProcessor);
      expect(lock.state).toBe('held');
      await waitFor(() => proc.worker.isRunning(), 10_000);

      // Лок уходит из-под живого воркера (в прод это случилось после сна
      // машины: PX истёк, ключ достался никому). renew() не продлит чужое
      // значение → onLost → pauseAll.
      await redisClient.set(
        workerLockKey(prefix),
        JSON.stringify({
          mode: 'agents',
          pid: 999_999,
          hostname: 'thief',
          acquired_at: new Date().toISOString(),
        }),
        'PX',
        LOCK_TTL_MS,
      );
      await waitFor(() => lock.state === 'blocked', 10_000);

      // Чужой держатель исчезает — воркер берёт лок обратно.
      await redisClient.del(workerLockKey(prefix));
      await waitFor(() => lock.state === 'held', 10_000);

      // Суть регрессии: «лок держится» само по себе ничего не значит —
      // проверяем, что джоба, положенная ПОСЛЕ re-acquire, реально исполнена.
      await waitFor(() => proc.worker.isRunning() && !proc.worker.isPaused(), 10_000);
      const runId = await seedMockRun(worker.get(RunTriggerService), 'LOCK-3');
      await waitFor(async () => (await runStatus(runId)) === 'succeeded', 30_000);

      await worker.close();
    },
  );

  it('distinct prefixes are independent (suite isolation)', { timeout: 60_000 }, async () => {
    const originalPrefix = process.env.BULLMQ_PREFIX;
    const workerA = await bootWorker('dev');
    expect(workerA.get(WorkerLockService).state).toBe('held');

    process.env.BULLMQ_PREFIX = `${originalPrefix}-alt`;
    try {
      const workerB = await bootWorker('agents');
      const lockB = workerB.get(WorkerLockService);
      // Different namespace → B holds its own lock immediately and runs.
      expect(lockB.state).toBe('held');
      expect(workerB.get(RunProcessor).worker.isRunning()).toBe(true);
      await workerB.close();
    } finally {
      process.env.BULLMQ_PREFIX = originalPrefix;
    }
    await workerA.close();
  });
});

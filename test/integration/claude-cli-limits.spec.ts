import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
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
 * T086 (US3, mandatory orphan-process test — SC-004): whatever kills the
 * run — timeout, operator cancellation, or budget ceiling — kills the
 * ENTIRE process tree, not just the direct child, and the run finalizes
 * exactly once.
 */
describe('claude_cli limits — timeout/cancel/budget, 0 orphans (T086/US3)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 700;

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

  async function pollRun(
    runId: string,
    until: (status: string) => boolean,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && until(row.status)) return row;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} stuck at ${row?.status} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const TERMINAL = (s: string): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(s);

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  async function waitForProcessesGone(pids: number[], timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const alive = pids.filter(isProcessAlive);
      if (alive.length === 0) return;
      if (Date.now() > deadline) throw new Error(`still alive after ${timeoutMs}ms: ${alive.join(',')}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('timeout: kills the whole process group (fake CLI + its spawned grandchild), 0 survivors', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-limits-timeout-'));
    const selfPidFile = join(dumpDir, 'self.pid');
    const childPidFile = join(dumpDir, 'child.pid');

    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_SPAWN_CHILD = '1';
    process.env.FAKE_CLAUDE_SELF_PID_FILE = selfPidFile;
    process.env.FAKE_CLAUDE_CHILD_PID_FILE = childPidFile;

    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { killGraceMs: 500 }),
      behavior: { allowed_tools: ['Read'], branch_prefix: 'feat' },
      ticketKey,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      // `timeoutMinutes` only has whole-minute granularity (DB column is
      // `integer`) — far too coarse to prove a REAL grandchild gets killed
      // rather than racing the pre-spawn work (worktree prepare's `git
      // clone`) or the child's own ~30-100ms Node startup. This override
      // (same established precedent as mock's `rate_limit_ttl_ms`) gives
      // both a comfortable head start before the timeout fires.
      triggerEvent: { source: 'manual', timeout_ms_override: 3000 },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId, (s) => s === 'timed_out', 30_000);
    expect(row.status).toBe('timed_out');

    await waitForProcessesGone(
      [Number(readFileSync(selfPidFile, 'utf8')), Number(readFileSync(childPidFile, 'utf8'))],
      10_000,
    );
  });

  it('cancellation: flipping runs.status off "running" kills the group and the run stays cancelled — no late revival', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-limits-cancel-'));
    const selfPidFile = join(dumpDir, 'self.pid');

    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    process.env.FAKE_CLAUDE_SELF_PID_FILE = selfPidFile;
    process.env.FAKE_CLAUDE_LINE_DELAY_MS = '1000'; // slow enough to cancel mid-stream

    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { cancelPollMs: 100, killGraceMs: 500 }),
      behavior: { allowed_tools: ['Read'], branch_prefix: 'feat' },
      ticketKey,
      timeoutMinutes: 45,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    // Wait for the run to actually be `running` (and the pid file to exist)
    // before simulating an operator/reconcile cancellation.
    await pollRun(res.runId, (s) => s === 'running', 10_000);
    const deadline = Date.now() + 10_000;
    while (!existsSync(selfPidFile)) {
      if (Date.now() > deadline) throw new Error('fake CLI never wrote its pid file');
      await new Promise((r) => setTimeout(r, 20));
    }
    const selfPid = Number(readFileSync(selfPidFile, 'utf8'));

    // Simulate "an operator/reconcile action flipped it toward cancelled"
    // (D4) — a direct write, bypassing guardedFinalize, exactly the
    // mechanism the cancel-poll is designed to observe.
    await db.db.update(schema.runs).set({ status: 'cancelled' }).where(eq(schema.runs.id, res.runId));

    await waitForProcessesGone([selfPid], 10_000);

    // Give the processor's own (now-redundant) finalize attempt a moment to
    // no-op, then confirm the row is still exactly `cancelled` with no report.
    await new Promise((r) => setTimeout(r, 500));
    const [finalRow] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, res.runId)).limit(1);
    expect(finalRow.status).toBe('cancelled');
    expect(finalRow.report).toBeNull();
  });

  it('budget: terminal cost over the ceiling finalizes failed with a budget diagnostic', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-budget-exceeded';

    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env),
      behavior: { allowed_tools: ['Read'], branch_prefix: 'feat' },
      ticketKey,
      maxBudgetUsd: 0.05, // fixture's terminal total_cost_usd is 0.12
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId, TERMINAL, 30_000);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/budget exceeded/);
    expect(Number(row.costUsd)).toBeCloseTo(0.12, 4);
  });

  it('near-simultaneous budget+timeout: the run is finalized exactly once (no double-finalize)', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-budget-exceeded';
    process.env.FAKE_CLAUDE_LINE_DELAY_MS = '50';

    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { killGraceMs: 300 }),
      behavior: { allowed_tools: ['Read'], branch_prefix: 'feat' },
      ticketKey,
      maxBudgetUsd: 0.05,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      // ~150ms lands mid-stream (5 lines * 50ms ≈ 250ms total) — close enough
      // to the stream's own natural completion to plausibly race it.
      triggerEvent: { source: 'manual', timeout_ms_override: 150 },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId, TERMINAL, 30_000);
    // Either cause is an acceptable single winner — what matters is there is
    // exactly one, and the row is stably terminal afterward.
    expect(['failed', 'timed_out']).toContain(row.status);

    await new Promise((r) => setTimeout(r, 1000));
    const [after] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, res.runId)).limit(1);
    expect(after.status).toBe(row.status);
    expect(after.finishedAt?.getTime()).toBe(row.finishedAt?.getTime());
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { runQueueName } from '@brigadir/queues';
import {
  sealExecutorSecrets,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  MOONSHOT_ANTHROPIC_BASE_URL,
} from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { DeepseekRunProcessor } from '../../apps/worker/src/deepseek-run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const DEEPSEEK_KEY = 'sk-deepseek-profile-key';
const MOONSHOT_KEY = 'sk-moonshot-companion-key';

type SuiteExecutorType = 'deepseek_api' | 'kimi' | 'claude_cli';

const MODEL_BY_TYPE: Record<SuiteExecutorType, string> = {
  deepseek_api: 'deepseek-v4-flash',
  kimi: 'kimi-k3',
  claude_cli: 'claude-sonnet-5',
};

/**
 * Feature 028 (T018/T019/T023/T027) — deepseek_api end-to-end through
 * `run.deepseek_api` on the SHARED Claude CLI harness: the spawned child env
 * carries the DeepSeek ANTHROPIC_BASE_URL constant + the profile's decrypted
 * key; claude_cli and kimi runs in the same worker keep their own env shape
 * (US2); the standard failure paths (rate limit, no-report, keyless profile)
 * behave like claude_cli; and run attribution
 * (`runs.executor_type = 'deepseek_api'`) is immutable under profile edits
 * and single-filter queryable. Mirrors kimi-run.spec.ts 1:1.
 */
describe('deepseek_api executor end-to-end (feature 028)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 2900;

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
    await worker.get(DeepseekRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function pollRun(runId: string, timeoutMs = 30_000): Promise<typeof schema.runs.$inferSelect> {
    const TERMINAL = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && TERMINAL.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Seed a pipeline on the given executor type; api_key-only profiles get a sealed key. */
  async function seed(executorType: SuiteExecutorType, opts: { keyless?: boolean } = {}) {
    const p = await seedPipeline(db.db, {
      executorType,
      executorConfig: baseExecutorConfig(env, { model: MODEL_BY_TYPE[executorType] }),
      behavior: { allowed_tools: ['Read'] },
      ticketKey: `BRIG-${nextTicket++}`,
    });
    if (executorType !== 'claude_cli' && !opts.keyless) {
      await db.db
        .update(schema.executors)
        .set({
          secrets: sealExecutorSecrets({
            api_key: executorType === 'deepseek_api' ? DEEPSEEK_KEY : MOONSHOT_KEY,
          }),
        })
        .where(eq(schema.executors.id, p.executorId));
    }
    return p;
  }

  async function triggerRun(p: { ticketId: string; agentId: string }, extraEvent: Record<string, unknown> = {}) {
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', ...extraEvent },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  async function runWithEnvDump(executorType: SuiteExecutorType) {
    const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-deepseek-dump-'));
    const envDumpPath = join(dumpDir, 'env.json');
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    process.env.FAKE_CLAUDE_ENV_DUMP = envDumpPath;

    const p = await seed(executorType);
    const runId = await triggerRun(p);
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    const envDump = JSON.parse(readFileSync(envDumpPath, 'utf8')) as Record<string, string>;
    return { p, runId, row, envDump };
  }

  it('T018: deepseek run through run.deepseek_api — child env carries the DeepSeek base URL + the profile key; report lands (SC-001)', async () => {
    const { row, envDump } = await runWithEnvDump('deepseek_api');

    expect(row.executorType).toBe('deepseek_api');
    expect(envDump.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(envDump.ANTHROPIC_API_KEY).toBe(DEEPSEEK_KEY);
    // A succeeded run through the deepseek processor IS the proof the
    // run.deepseek_api queue is provisioned AND consumed (worker-lock
    // registration, research D6) — an unconsumed queue would leave the run
    // stuck at `queued` and fail the poll above.
    expect(row.report).toBeTruthy();
  });

  it('T023 (US2): a claude_cli run in the same worker has NO base-URL key at all', async () => {
    const { row, envDump } = await runWithEnvDump('claude_cli');

    expect(row.executorType).toBe('claude_cli');
    expect('ANTHROPIC_BASE_URL' in envDump).toBe(false);
  });

  it('T023 (US2): a kimi run in the same worker still gets exactly the Moonshot base URL, never DeepSeek', async () => {
    const { row, envDump } = await runWithEnvDump('kimi');

    expect(row.executorType).toBe('kimi');
    expect(envDump.ANTHROPIC_BASE_URL).toBe(MOONSHOT_ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_BASE_URL).not.toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_API_KEY).toBe(MOONSHOT_KEY);
  });

  it('T019: rate limit parity — api_retry recorded, run stays active, attempt not spent (SC-009)', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-rate-limit';

    const p = await seed('deepseek_api');
    const runId = await triggerRun(p, { rate_limit_ttl_ms: 200 });

    const deadline = Date.now() + 15_000;
    let events: (typeof schema.runEvents.$inferSelect)[] = [];
    for (;;) {
      events = await db.db
        .select()
        .from(schema.runEvents)
        .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'api_retry')));
      if (events.length > 0) break;
      if (Date.now() > deadline) throw new Error(`no api_retry event for run ${runId}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(events[0].payload).toMatchObject({ error: 'rate_limit', attempt: 1 });

    await new Promise((r) => setTimeout(r, 500));
    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(['queued', 'running']).toContain(row.status);
    expect(row.attempt).toBe(1);

    // The fixture signals rate_limit forever — wipe the queue so the requeue
    // loop doesn't race suite teardown (same pattern as the kimi suite).
    const queue = worker.get<Queue>(getQueueToken(runQueueName('deepseek_api')), { strict: false });
    await queue.obliterate({ force: true });
  });

  it('T019: no-report crash parity — finalizes failed with a diagnostic (SC-009)', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-no-report';

    const p = await seed('deepseek_api');
    const runId = await triggerRun(p);
    const row = await pollRun(runId);

    expect(row.status).toBe('failed');
    expect(row.report).toBeNull();
    expect(row.error).toBeTruthy();
  });

  it('T019: keyless deepseek profile fails fast through the normal failed-run path with the per-type message', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';

    const p = await seed('deepseek_api', { keyless: true });
    const runId = await triggerRun(p);
    const row = await pollRun(runId);

    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no stored API key/);
    expect(row.error).toMatch(/deepseek_api/);
    expect(row.error).toMatch(/DeepSeek/);
  });

  it('T027 (US5): attribution is immutable under profile edits and single-filter queryable (SC-007)', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';

    const { p, runId } = await runWithEnvDump('deepseek_api');

    // Edit the profile after the fact — rename + model swap.
    await db.db
      .update(schema.executors)
      .set({
        name: `renamed-${Date.now()}`,
        config: { ...baseExecutorConfig(env), model: 'deepseek-v4-pro' },
      })
      .where(eq(schema.executors.id, p.executorId));

    const [after] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(after.executorType).toBe('deepseek_api');

    // Single equality filter returns exactly the DeepSeek-backed runs (this
    // suite also ran claude_cli + kimi + rate-limit/keyless runs in the same DB).
    const deepseekRuns = await db.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.executorType, 'deepseek_api'));
    expect(deepseekRuns.length).toBeGreaterThanOrEqual(1);
    expect(deepseekRuns.every((r) => r.executorType === 'deepseek_api')).toBe(true);
    expect(deepseekRuns.some((r) => r.id === runId)).toBe(true);
    const otherRuns = await db.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.executorType, 'kimi'));
    expect(otherRuns.some((r) => r.id === runId)).toBe(false);
  });
});

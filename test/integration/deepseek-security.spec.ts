import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import {
  sealExecutorSecrets,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  MOONSHOT_ANTHROPIC_BASE_URL,
} from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { DeepseekRunProcessor } from '../../apps/worker/src/deepseek-run.processor';
import { KimiRunProcessor } from '../../apps/worker/src/kimi-run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const DEEPSEEK_KEY = 'sk-deepseek-security-key';
const MOONSHOT_KEY = 'sk-moonshot-security-companion';

type SuiteExecutorType = 'deepseek_api' | 'kimi' | 'claude_cli';

/**
 * Feature 028 (T026, US4 — SC-003, SC-006 automated half; contracts/
 * deepseek-provider-env.md invariants 1–5): with the worker's own shell
 * polluted by host provider variables, a deepseek_api run's child env
 * contains EXACTLY the DeepSeek constant + the profile's key, a claude_cli
 * run's child env contains no base URL, a kimi run keeps exactly Moonshot
 * (never DeepSeek), and no host canary reaches any of them. The key travels
 * via env only — never argv (Constitution V). Mirrors kimi-security.spec.ts.
 */
describe('deepseek security floor — host env can never leak (feature 028, T026)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 3100;

  const HOST_CANARIES: Record<string, string> = {
    ANTHROPIC_BASE_URL: 'https://host-canary.example.com',
    ANTHROPIC_API_KEY: 'sk-ant-host-canary',
    OPENAI_API_KEY: 'sk-openai-host-canary',
    OPENAI_BASE_URL: 'https://openai-canary.example.com',
  };
  const savedEnv: Record<string, string | undefined> = {};

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
    await worker.get(KimiRunProcessor).worker.waitUntilReady();
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

  /** One polluted-shell run; returns the child's env and argv dumps. */
  async function runPolluted(executorType: SuiteExecutorType) {
    for (const [key, value] of Object.entries(HOST_CANARIES)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-deepseek-sec-'));
      const envDumpPath = join(dumpDir, 'env.json');
      const argvDumpPath = join(dumpDir, 'argv.json');

      resetFakeClaudeEnv();
      process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
      process.env.FAKE_CLAUDE_ENV_DUMP = envDumpPath;
      process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpPath;

      const p = await seedPipeline(db.db, {
        executorType,
        executorConfig: baseExecutorConfig(env, {
          model: executorType === 'deepseek_api' ? 'deepseek-v4-flash' : executorType === 'kimi' ? 'kimi-k3' : 'claude-sonnet-5',
        }),
        behavior: { allowed_tools: ['Read'] },
        ticketKey: `BRIG-${nextTicket++}`,
      });
      if (executorType !== 'claude_cli') {
        await db.db
          .update(schema.executors)
          .set({
            secrets: sealExecutorSecrets({
              api_key: executorType === 'deepseek_api' ? DEEPSEEK_KEY : MOONSHOT_KEY,
            }),
          })
          .where(eq(schema.executors.id, p.executorId));
      }
      const res = await trigger.trigger({
        ticketId: p.ticketId,
        agentId: p.agentId,
        triggerEvent: { source: 'manual' },
      });
      if (res.deduplicated) throw new Error('unexpected dedup');
      const row = await pollRun(res.runId);
      expect(row.status).toBe('succeeded');

      return {
        runId: res.runId,
        envDump: JSON.parse(readFileSync(envDumpPath, 'utf8')) as Record<string, string>,
        argvDump: JSON.parse(readFileSync(argvDumpPath, 'utf8')) as string[],
      };
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('deepseek child env = DeepSeek constant + profile key exactly; every host canary stripped; key never in argv', async () => {
    const { runId, envDump, argvDump } = await runPolluted('deepseek_api');

    // Injected values come from the preset constant + the profile row only.
    expect(envDump.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_API_KEY).toBe(DEEPSEEK_KEY);
    // Host canaries never pass the allowlist floor.
    expect(envDump.ANTHROPIC_BASE_URL).not.toBe(HOST_CANARIES.ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_API_KEY).not.toBe(HOST_CANARIES.ANTHROPIC_API_KEY);
    expect(envDump.OPENAI_API_KEY).toBeUndefined();
    expect(envDump.OPENAI_BASE_URL).toBeUndefined();
    // Constitution V: secrets never in argv.
    expect(argvDump.join(' ')).not.toContain(DEEPSEEK_KEY);

    // SC-006 automated half: the key never lands in the run row or its
    // timeline events (the scrubber masks any echo). runEvents carries a
    // bigint seq column — stringify with a BigInt-safe replacer.
    const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(JSON.stringify(row, bigintSafe)).not.toContain(DEEPSEEK_KEY);
    const events = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    expect(JSON.stringify(events, bigintSafe)).not.toContain(DEEPSEEK_KEY);
  });

  it('claude_cli child env in the same polluted shell has NO base URL and no deepseek-derived values', async () => {
    const { envDump } = await runPolluted('claude_cli');

    expect('ANTHROPIC_BASE_URL' in envDump).toBe(false);
    expect(envDump.ANTHROPIC_API_KEY).not.toBe(HOST_CANARIES.ANTHROPIC_API_KEY);
    expect(envDump.ANTHROPIC_API_KEY).not.toBe(DEEPSEEK_KEY);
    expect(envDump.OPENAI_API_KEY).toBeUndefined();
    expect(envDump.OPENAI_BASE_URL).toBeUndefined();
  });

  it('kimi child env in the same polluted shell keeps exactly the Moonshot constant — never DeepSeek', async () => {
    const { envDump } = await runPolluted('kimi');

    expect(envDump.ANTHROPIC_BASE_URL).toBe(MOONSHOT_ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_BASE_URL).not.toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
    expect(envDump.ANTHROPIC_API_KEY).toBe(MOONSHOT_KEY);
    expect(envDump.ANTHROPIC_API_KEY).not.toBe(DEEPSEEK_KEY);
  });
});

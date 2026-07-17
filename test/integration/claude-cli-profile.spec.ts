import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { sealExecutorSecrets } from '@brigadir/executors';
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
 * Runner-profile runtime semantics (named runner profiles, 2026-07-14),
 * proven through the real spawn path via the fake CLI's env/argv dumps:
 *  - ANTHROPIC_API_KEY is present in the child env IFF the profile stores a
 *    key (billed by key vs host subscription) — and it is the DECRYPTED value
 *    of the sealed `executors.secrets` blob;
 *  - the PROFILE's model wins unconditionally: a legacy `agents.behavior.model`
 *    never reaches `--model` (no data migration; live agent TEST keeps working).
 */
describe('claude_cli runner-profile runtime (api key injection + model precedence)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 700;

  const PROFILE_KEY = 'sk-ant-profile-key-77';

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

  /** One full run; returns the fake CLI's env + argv dumps. */
  async function runOnce(opts: {
    withProfileKey: boolean;
    behavior?: Record<string, unknown>;
    model?: string;
    configOverrides?: Record<string, unknown>;
  }): Promise<{ envDump: Record<string, string>; argvDump: string[] }> {
    const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-profile-dump-'));
    const envDumpPath = join(dumpDir, 'env.json');
    const argvDumpPath = join(dumpDir, 'argv.json');

    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    process.env.FAKE_CLAUDE_ENV_DUMP = envDumpPath;
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpPath;

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, {
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.configOverrides ?? {}),
      }),
      behavior: { allowed_tools: ['Read'], ...(opts.behavior ?? {}) },
      ticketKey: `BRIG-${nextTicket++}`,
    });
    if (opts.withProfileKey) {
      await db.db
        .update(schema.executors)
        .set({ secrets: sealExecutorSecrets({ api_key: PROFILE_KEY }) })
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
      envDump: JSON.parse(readFileSync(envDumpPath, 'utf8')) as Record<string, string>,
      argvDump: JSON.parse(readFileSync(argvDumpPath, 'utf8')) as string[],
    };
  }

  it('profile WITH a sealed api key → child env carries the decrypted ANTHROPIC_API_KEY', async () => {
    const { envDump } = await runOnce({ withProfileKey: true });
    expect(envDump.ANTHROPIC_API_KEY).toBe(PROFILE_KEY);
  });

  it('profile WITHOUT a key → no ANTHROPIC_API_KEY in the child env (host subscription)', async () => {
    const { envDump } = await runOnce({ withProfileKey: false });
    expect(envDump.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('bedrock profile WITH a sealed key → key stays INERT: bedrock env, no ANTHROPIC_API_KEY (018/T011)', async () => {
    const { envDump } = await runOnce({
      withProfileKey: true,
      configOverrides: { auth: 'bedrock', awsRegion: 'eu-west-1' },
    });
    expect(envDump.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(envDump.AWS_REGION).toBe('eu-west-1');
    expect(envDump.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('explicit host_subscription WITH a sealed key → nothing injected (018/T011)', async () => {
    const { envDump } = await runOnce({
      withProfileKey: true,
      configOverrides: { auth: 'host_subscription' },
    });
    expect(envDump.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envDump.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(envDump.AWS_REGION).toBeUndefined();
  });

  it('the profile model reaches --model; a legacy behavior.model is ignored unconditionally', async () => {
    const { argvDump } = await runOnce({
      withProfileKey: false,
      model: 'profile-model-wins',
      behavior: { model: 'legacy-behavior-model' },
    });
    const modelIdx = argvDump.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(argvDump[modelIdx + 1]).toBe('profile-model-wins');
    expect(argvDump).not.toContain('legacy-behavior-model');
  });
});

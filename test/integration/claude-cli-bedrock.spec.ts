import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
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
 * Feature 018 (T007, US1 — SC-001/SC-003 integration half): a bedrock-mode
 * profile drives the spawned CLI with EXACTLY the profile-derived Bedrock
 * env, proven through the real worker/spawn path via the fake CLI's env dump.
 * The worker's own shell is deliberately polluted with canary AWS/Bedrock
 * variables — none of them may reach the child (profile values win; the
 * allowlist floor strips the rest by construction).
 */
describe('claude_cli bedrock auth mode (feature 018, T007)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 800;

  const HOST_CANARIES: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: 'host-canary-flag',
    AWS_REGION: 'host-canary-region',
    AWS_PROFILE: 'host-canary-profile',
    AWS_SECRET_ACCESS_KEY: 'host-canary-aws-secret',
    AWS_SESSION_TOKEN: 'host-canary-aws-session',
    NODE_EXTRA_CA_CERTS: '/host/canary/ca.pem',
    ANTHROPIC_API_KEY: 'sk-ant-host-canary',
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

  /** One full bedrock-profile run with a canary-polluted worker env; returns the child env dump. */
  async function runBedrock(authConfig: Record<string, unknown>): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(HOST_CANARIES)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-bedrock-dump-'));
      const envDumpPath = join(dumpDir, 'env.json');

      resetFakeClaudeEnv();
      process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
      process.env.FAKE_CLAUDE_ENV_DUMP = envDumpPath;

      const p = await seedPipeline(db.db, {
        executorType: 'claude_cli',
        executorConfig: baseExecutorConfig(env, authConfig),
        behavior: { allowed_tools: ['Read'] },
        ticketKey: `BRIG-${nextTicket++}`,
      });
      const res = await trigger.trigger({
        ticketId: p.ticketId,
        agentId: p.agentId,
        triggerEvent: { source: 'manual' },
      });
      if (res.deduplicated) throw new Error('unexpected dedup');
      const row = await pollRun(res.runId);
      expect(row.status).toBe('succeeded');

      return JSON.parse(readFileSync(envDumpPath, 'utf8')) as Record<string, string>;
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('full bedrock profile → child env carries exactly the profile values; host canaries never leak', async () => {
    const envDump = await runBedrock({
      auth: 'bedrock',
      awsRegion: 'eu-west-1',
      awsProfile: 'corp-dev',
      caBundlePath: '/etc/ssl/corp/ca-bundle.pem',
    });

    expect(envDump.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(envDump.AWS_REGION).toBe('eu-west-1');
    expect(envDump.AWS_PROFILE).toBe('corp-dev');
    expect(envDump.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp/ca-bundle.pem');
    // No first-party key in bedrock mode — and never the host's.
    expect(envDump.ANTHROPIC_API_KEY).toBeUndefined();
    // Credential canaries must be stripped by the allowlist floor (FR-005/006).
    expect(envDump.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(envDump.AWS_SESSION_TOKEN).toBeUndefined();
    // Profile values won over every same-named host canary.
    for (const [key, canary] of Object.entries(HOST_CANARIES)) {
      expect(envDump[key], key).not.toBe(canary);
    }
  });

  it('region-only bedrock profile → AWS default credential chain (no AWS_PROFILE, no CA bundle)', async () => {
    const envDump = await runBedrock({ auth: 'bedrock', awsRegion: 'us-east-1' });

    expect(envDump.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(envDump.AWS_REGION).toBe('us-east-1');
    expect(envDump.AWS_PROFILE).toBeUndefined();
    expect(envDump.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(envDump.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

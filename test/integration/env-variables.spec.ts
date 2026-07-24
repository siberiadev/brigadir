import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { sealEnvSecrets } from '@brigadir/executors';
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
 * Feature 031 (US1 T015 / US2 T022): operator env reaches the spawned run with
 * documented precedence and secret values are usable but never leak into
 * persisted run artifacts. Driven end-to-end through the real worker/spawn path
 * with FAKE_CLAUDE_ENV_DUMP capturing the child's environment.
 */
describe('operator env variables — injection + secret isolation (feature 031)', () => {
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
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

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

  const productRepo = (extra: Record<string, unknown> = {}) => ({
    id: 'repo-product-031',
    name: 'product',
    git_url: env.remoteDir,
    default_branch: 'main',
    ...extra,
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

  /** Seed a workspace, optionally seal an env-secrets doc, run it, return the env dump + run id. */
  async function runWith(opts: {
    workspaceSettings: Record<string, unknown>;
    sealSecrets?: (workspaceId: string, agentId: string) => Parameters<typeof sealEnvSecrets>[0];
  }): Promise<{ envDump: Record<string, string>; runId: string }> {
    const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-env-dump-'));
    const envDumpPath = join(dumpDir, 'env.json');
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    process.env.FAKE_CLAUDE_ENV_DUMP = envDumpPath;

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env),
      behavior: { allowed_tools: ['Read'] },
      workspaceSettings: opts.workspaceSettings,
      ticketKey: `BRIG-${nextTicket++}`,
      maxAttempts: 1,
    });

    if (opts.sealSecrets) {
      await db.db
        .update(schema.workspaces)
        .set({ envSecrets: sealEnvSecrets(opts.sealSecrets(p.workspaceId, p.agentId)) })
        .where(eq(schema.workspaces.id, p.workspaceId));
    }

    const res = await trigger.trigger({ ticketId: p.ticketId, agentId: p.agentId, triggerEvent: { source: 'manual' } });
    if (res.deduplicated) throw new Error('unexpected dedup');
    const row = await pollRun(res.runId);
    expect(row.status).toBe('succeeded');
    const envDump = JSON.parse(readFileSync(envDumpPath, 'utf8')) as Record<string, string>;
    return { envDump, runId: res.runId };
  }

  it('injects workspace + repo env with repo overriding workspace on a shared key (US1)', async () => {
    const { envDump } = await runWith({
      workspaceSettings: {
        env: { NODE_ENV: 'test', WS_ONLY: 'w' },
        repositories: [productRepo({ env: { PORT: '3100', NODE_ENV: 'e2e' } })],
      },
    });
    expect(envDump.WS_ONLY).toBe('w');
    expect(envDump.PORT).toBe('3100');
    expect(envDump.NODE_ENV).toBe('e2e');
  });

  it('holds the allowlist floor even with user env configured (T085 extension)', async () => {
    const saved = process.env.LEAKY_HOST_SECRET_031;
    process.env.LEAKY_HOST_SECRET_031 = 'must-not-appear';
    try {
      const { envDump } = await runWith({
        workspaceSettings: { env: { SAFE: 'ok' }, repositories: [productRepo()] },
      });
      expect(envDump.SAFE).toBe('ok');
      expect(envDump.LEAKY_HOST_SECRET_031).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.LEAKY_HOST_SECRET_031;
      else process.env.LEAKY_HOST_SECRET_031 = saved;
    }
  });

  it('delivers a secret env value to the run but never persists it (US2 leak sweep)', async () => {
    const SECRET = 'postgres://svc:s3cretpw031@db:5432/app';
    const { envDump, runId } = await runWith({
      workspaceSettings: { repositories: [productRepo()] },
      sealSecrets: () => ({ repos: { 'repo-product-031': { DATABASE_URL: SECRET } } }),
    });
    // Present in the spawned child (the agent can use it)...
    expect(envDump.DATABASE_URL).toBe(SECRET);

    // ...but the literal value appears in NO persisted run artifact.
    const events = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    for (const e of events) {
      expect(JSON.stringify(e.payload)).not.toContain('s3cretpw031');
    }
    const [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(JSON.stringify(run.report ?? {})).not.toContain('s3cretpw031');
    expect(run.error ?? '').not.toContain('s3cretpw031');
  });

  it('merges secret and non-secret env at the same repo scope (US2)', async () => {
    const { envDump } = await runWith({
      workspaceSettings: { repositories: [productRepo({ env: { PORT: '3100' } })] },
      sealSecrets: () => ({ repos: { 'repo-product-031': { API_TOKEN: 'tok-031' } } }),
    });
    expect(envDump.PORT).toBe('3100');
    expect(envDump.API_TOKEN).toBe('tok-031');
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const JWT_SECRET = 'artifact-guard-test-jwt-secret';

/**
 * Feature 026 (US2) — the deployment guard. A stale/missing agent tool-server
 * artifact hard-fails a callback-wired run at pickup (before any spawn) with an
 * explicit error; Phase-0 (non-callback) runs are never affected; a fresh
 * rebuild heals the worker without a restart. The artifact/src paths are
 * overridden onto scratch files so mtimes are controllable and the real
 * packages/mcp-server build state is irrelevant.
 *
 * A live backend is booted so US4's pre-flight probe (also on callback-wired
 * runs) passes — the guard is what this suite exercises.
 */
describe('deployment guard (feature 026, US2)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let scratch: string;
  let nextTicket = 300;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    scratch = await mkdtemp(join(tmpdir(), 'brigadir-guard-it-'));
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;
    // Re-evaluate the guard on every pickup so a heal is seen without restart.
    process.env.BRIGADIR_ARTIFACT_GUARD_TTL_MS = '1';
    // Isolate the outbox dir; keep the periodic reconciler dormant.
    process.env.BRIGADIR_MCP_CONFIG_ROOT = join(scratch, 'cfg');
    process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS = String(60 * 60_000);

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    process.env.BRIGADIR_CALLBACK_BASE_URL = `${await backend.getUrl()}/api/callbacks`;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
    await rm(scratch, { recursive: true, force: true });
    delete process.env.BRIGADIR_MCP_SERVER_ENTRY;
    delete process.env.BRIGADIR_MCP_SERVER_SRC;
    delete process.env.BRIGADIR_ARTIFACT_GUARD_TTL_MS;
    delete process.env.BRIGADIR_MCP_CONFIG_ROOT;
    delete process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS;
  });

  afterEach(() => resetFakeClaudeEnv());

  async function pollRun(runId: string, timeoutMs = 30_000): Promise<typeof schema.runs.$inferSelect> {
    const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && terminal.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function triggerRun(overrides: Record<string, unknown>, fixture?: string): Promise<string> {
    resetFakeClaudeEnv();
    if (fixture) process.env.FAKE_CLAUDE_FIXTURE = fixture;
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, overrides),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] },
      ticketKey: `BRIG-${nextTicket++}`,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({ ticketId: p.ticketId, agentId: p.agentId, triggerEvent: { source: 'manual' } });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  /** A fresh artifact: entry newer than the newest src file. */
  async function freshArtifact(): Promise<void> {
    const entry = join(scratch, 'dist', 'main.js');
    const src = join(scratch, 'src');
    await mkdir(join(scratch, 'dist'), { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'a.ts'), 'x');
    await writeFile(entry, 'built');
    await utimes(join(src, 'a.ts'), new Date(1_000_000), new Date(1_000_000));
    await utimes(entry, new Date(2_000_000), new Date(2_000_000));
    process.env.BRIGADIR_MCP_SERVER_ENTRY = entry;
    process.env.BRIGADIR_MCP_SERVER_SRC = src;
  }

  it('missing artifact ⇒ callback-wired run fails with the explicit guard error, nothing spawned', async () => {
    process.env.BRIGADIR_MCP_SERVER_ENTRY = join(scratch, 'nope', 'main.js'); // does not exist
    process.env.BRIGADIR_MCP_SERVER_SRC = join(scratch, 'src-missing');

    const runId = await triggerRun({ useCallbackChannel: true }, 'stream-success');
    const row = await pollRun(runId);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('DEPLOYMENT GUARD');
    expect(row.error).toContain('pnpm build:mcp-server');
    // Guard fires BEFORE prepare/spawn — no worktree was ever created.
    expect(row.worktreePath).toBeNull();
  });

  it('Phase-0 (non-callback) run is unaffected by a missing artifact', async () => {
    process.env.BRIGADIR_MCP_SERVER_ENTRY = join(scratch, 'nope', 'main.js');
    process.env.BRIGADIR_MCP_SERVER_SRC = join(scratch, 'src-missing');

    const runId = await triggerRun({ useCallbackChannel: false }, 'stream-success');
    const row = await pollRun(runId);

    expect(row.status).toBe('succeeded');
    expect(row.report).toMatchObject({ outcome: 'success' });
  });

  it('a fresh rebuild heals the worker without a restart', async () => {
    await freshArtifact();

    const runId = await triggerRun({ useCallbackChannel: true }, 'stream-success');
    const row = await pollRun(runId);

    // No guard failure — the run proceeded to spawn. (With no callback landing
    // it fail-closes as `failed`, but NOT with a DEPLOYMENT GUARD error, and a
    // worktree was created — proving the guard passed and the agent ran.)
    expect(row.error ?? '').not.toContain('DEPLOYMENT GUARD');
    expect(row.worktreePath).toBeTruthy();
  });
});

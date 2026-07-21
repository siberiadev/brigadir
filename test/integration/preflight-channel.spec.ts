import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

/**
 * Feature 026 (US4) — pre-flight channel check. With the callback endpoint
 * down, a callback-wired run is held (no spawn, no attempt burned, status
 * stays queued) with visible channel_down events, and proceeds once the
 * endpoint recovers. Phase-0 (mock) runs never probe.
 *
 * The dead endpoint is a port we bind then release; recovery binds a real
 * 200-responder on that same port. Fresh artifact override keeps the
 * deployment guard green so this suite isolates the probe.
 */
describe('pre-flight channel check (feature 026, US4)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let scratch: string;
  let deadPort: number;
  let nextTicket = 600;

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((res) => s.close(() => res()));
    return port;
  }

  function startHealthServer(port: number): Promise<Server> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        if (req.url?.endsWith('/health')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
  }

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    scratch = await mkdtemp(join(tmpdir(), 'brigadir-probe-it-'));
    db = await startDatabase();
    redis = await startRedis();
    deadPort = await freePort();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = 'preflight-test-jwt-secret';
    process.env.BRIGADIR_CALLBACK_BASE_URL = `http://127.0.0.1:${deadPort}/api/callbacks`;
    // Short holds so a recovered run retries within the test window.
    process.env.BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS = '400';
    process.env.BRIGADIR_CHANNEL_PROBE_MAX_TTL_MS = '800';
    process.env.BRIGADIR_MCP_CONFIG_ROOT = join(scratch, 'cfg');
    process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS = String(60 * 60_000);
    await freshArtifact(scratch);

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    await worker.get(RunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
    await rm(scratch, { recursive: true, force: true });
    for (const k of [
      'BRIGADIR_MCP_SERVER_ENTRY',
      'BRIGADIR_MCP_SERVER_SRC',
      'BRIGADIR_CALLBACK_BASE_URL',
      'BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS',
      'BRIGADIR_CHANNEL_PROBE_MAX_TTL_MS',
      'BRIGADIR_MCP_CONFIG_ROOT',
      'BRIGADIR_OUTBOX_RECONCILE_EVERY_MS',
    ]) {
      delete process.env[k];
    }
  });

  async function freshArtifact(base: string): Promise<void> {
    const entry = join(base, 'dist', 'main.js');
    const src = join(base, 'src');
    await mkdir(join(base, 'dist'), { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'a.ts'), 'x');
    await writeFile(entry, 'built');
    await utimes(join(src, 'a.ts'), new Date(1_000_000), new Date(1_000_000));
    await utimes(entry, new Date(2_000_000), new Date(2_000_000));
    process.env.BRIGADIR_MCP_SERVER_ENTRY = entry;
    process.env.BRIGADIR_MCP_SERVER_SRC = src;
  }

  async function row(runId: string): Promise<typeof schema.runs.$inferSelect> {
    const [r] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    return r;
  }

  async function channelDownCount(runId: string): Promise<number> {
    const events = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    return events.filter((e) => e.type === 'channel_down').length;
  }

  it('holds a callback-wired run while the channel is down, then proceeds on recovery', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] },
      ticketKey: `BRIG-${nextTicket++}`,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({ ticketId: p.ticketId, agentId: p.agentId, triggerEvent: { source: 'manual' } });
    if (res.deduplicated) throw new Error('unexpected dedup');
    const runId = res.runId;

    // While the channel is down: the run stays queued, never spawns, never
    // consumes an attempt, and accumulates channel_down events.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await channelDownCount(runId)) < 2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const held = await row(runId);
    expect(held.status).toBe('queued');
    expect(held.attempt).toBe(1); // no attempt burned
    expect(held.worktreePath).toBeNull(); // never spawned
    expect(await channelDownCount(runId)).toBeGreaterThanOrEqual(2);

    // Recover the channel — the held run now spawns and proceeds. Proof of
    // "proceeded" is a worktree being prepared (only happens after the probe
    // passes and markRunning), so poll for worktreePath rather than merely
    // "no longer queued" (which flips at markRunning, before prepare).
    const server = await startHealthServer(deadPort);
    try {
      const deadline2 = Date.now() + 25_000;
      for (;;) {
        const r = await row(runId);
        if (r.worktreePath) break;
        if (Date.now() > deadline2) throw new Error(`run ${runId} never spawned after recovery (status ${r.status})`);
        await new Promise((res2) => setTimeout(res2, 150));
      }
      expect((await row(runId)).worktreePath).toBeTruthy();
    } finally {
      await new Promise<void>((res2) => server.close(() => res2()));
    }
  }, 40_000);

  it('a Phase-0 (mock) run is unaffected by a dead channel', async () => {
    const p = await seedPipeline(db.db, { executorType: 'mock', ticketKey: `BRIG-${nextTicket++}` });
    const res = await trigger.trigger({ ticketId: p.ticketId, agentId: p.agentId, triggerEvent: { source: 'manual' } });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = await row(res.runId);
      if (['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(r.status)) {
        expect(r.status).toBe('succeeded');
        // No probe on the mock path.
        expect(await channelDownCount(res.runId)).toBe(0);
        return;
      }
      if (Date.now() > deadline) throw new Error(`mock run ${res.runId} stuck at ${r.status}`);
      await new Promise((res2) => setTimeout(res2, 100));
    }
  }, 30_000);
});

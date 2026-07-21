import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { outboxFilePath } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  setFakeClaudeCallbacks,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const JWT_SECRET = 'exit-reconcile-test-jwt-secret';
const VALID_REPORT = { schema_version: 2, outcome: 'success', summary: 'verdict computed', checks: [] };

/**
 * Feature 026 (US1) — exit-time outbox reconcile. A callback-wired agent whose
 * completion callbacks never landed but whose verdict is in the durable outbox
 * is finalized at process exit instead of being lost (the 3f60c1a1 case);
 * intentional stops (cancelled) keep their status but surface the report.
 *
 * The tool-server artifact + src paths are overridden fresh so the deployment
 * guard passes; a live backend keeps the pre-flight probe green. The fake CLI
 * makes NO callbacks — it lingers so the outbox file can be planted while the
 * run is 'running', then exits, driving the exit-time branch.
 */
describe('claude_cli exit-time outbox reconcile (feature 026, US1)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let scratch: string;
  let configRoot: string;
  let nextTicket = 400;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    scratch = await mkdtemp(join(tmpdir(), 'brigadir-exit-it-'));
    configRoot = join(scratch, 'cfg');
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;
    process.env.BRIGADIR_MCP_CONFIG_ROOT = configRoot;
    process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS = String(60 * 60_000); // dormant during the suite
    await freshArtifact(scratch);

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
    delete process.env.BRIGADIR_MCP_CONFIG_ROOT;
    delete process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS;
  });

  afterEach(() => resetFakeClaudeEnv());

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

  async function writeOutbox(runId: string, report: unknown): Promise<string> {
    const file = outboxFilePath(configRoot, runId);
    await mkdir(join(configRoot, '.brigadir-outbox'), { recursive: true });
    await writeFile(file, JSON.stringify({ runId, outcome: 'success', report, timestamp: 't' }));
    return file;
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async function startLingeringRun(lingerMs: number, emitResult: boolean): Promise<string> {
    resetFakeClaudeEnv();
    // Linger so the outbox can be planted mid-run. Makes NO complete_task
    // callback. When `emitResult`, stream a fixture whose terminal `result`
    // event makes the executor map the clean exit to `completed` (the 3f60c1a1
    // shape). Otherwise it just lingers until aborted (the cancelled case).
    const steps: Array<Record<string, unknown>> = [{ tool: 'sleep', ms: lingerMs }];
    if (emitResult) steps.push({ tool: 'stream', fixture: 'stream-no-report' });
    setFakeClaudeCallbacks(steps as Parameters<typeof setFakeClaudeCallbacks>[0]);
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, cancelPollMs: 150 }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] },
      ticketKey: `BRIG-${nextTicket++}`,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({ ticketId: p.ticketId, agentId: p.agentId, triggerEvent: { source: 'manual' } });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  async function pollStatus(runId: string, want: (s: string) => boolean, timeoutMs = 30_000): Promise<typeof schema.runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && want(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  const TERMINAL = (s: string): boolean => ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(s);

  async function undeliveredEvents(runId: string): Promise<Array<{ payload: unknown }>> {
    const events = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    return events.filter((e) => e.type === 'undelivered_report');
  }

  it('completed exit with a valid outbox report ⇒ run is rescued (succeeded), file consumed', async () => {
    const runId = await startLingeringRun(2000, true);
    await pollStatus(runId, (s) => s === 'running');
    const file = await writeOutbox(runId, VALID_REPORT);

    const row = await pollStatus(runId, TERMINAL);
    expect(row.status).toBe('succeeded');
    expect(row.report).toMatchObject({ outcome: 'success' });
    expect(row.outcome).toBe('success');
    expect(await fileExists(file)).toBe(false); // consumed
    // No fail-closed diagnostic.
    expect(row.error ?? '').not.toContain('without a complete_task');
  });

  it('completed exit with a schema-INVALID outbox report ⇒ fail closed, file preserved', async () => {
    const runId = await startLingeringRun(2000, true);
    await pollStatus(runId, (s) => s === 'running');
    const file = await writeOutbox(runId, { outcome: 'not-a-real-outcome' });

    const row = await pollStatus(runId, TERMINAL);
    expect(row.status).toBe('failed');
    expect(row.report).toBeNull();
    expect(await fileExists(file)).toBe(true); // preserved for inspection (FR-007)
  });

  it('cancelled run with a valid outbox report ⇒ status stays cancelled, report attached, file consumed', async () => {
    const runId = await startLingeringRun(5000, false);
    await pollStatus(runId, (s) => s === 'running');
    const file = await writeOutbox(runId, VALID_REPORT);
    // Operator cancel: flip the row to cancelled; the cancel-poll aborts the
    // lingering process and the exit maps to 'cancelled'.
    await db.db.update(schema.runs).set({ status: 'cancelled' }).where(eq(schema.runs.id, runId));

    // Wait for the exit-branch to run (it attaches the event + consumes the file).
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await undeliveredEvents(runId)).length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(row.status).toBe('cancelled'); // never clobbered
    const undelivered = await undeliveredEvents(runId);
    expect(undelivered).toHaveLength(1);
    expect((undelivered[0].payload as { run_status: string }).run_status).toBe('cancelled');
    expect((undelivered[0].payload as { source: string }).source).toBe('exit_reconcile');
    expect(await fileExists(file)).toBe(false); // consumed
  });
});

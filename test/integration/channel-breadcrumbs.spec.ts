import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, access, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { channelBreadcrumbDirPath, channelBreadcrumbFilePath, outboxFilePath } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { OutboxReconcileService } from '../../apps/worker/src/outbox-reconcile.service';
import { CHANNEL_FAILURE_EVENT } from '../../apps/worker/src/channel-breadcrumb-ingest';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  setFakeClaudeCallbacks,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const JWT_SECRET = 'channel-breadcrumbs-test-jwt-secret';
const VALID_REPORT = { schema_version: 2, outcome: 'success', summary: 'verdict computed', checks: [] };

function record(tool: string, ts: string): Record<string, unknown> {
  return {
    ts,
    tool,
    kind: 'network',
    attempts: 11,
    error: { name: 'TypeError', message: 'fetch failed' },
    target: '127.0.0.1:39999',
  };
}

/**
 * Feature 027 (US3) — channel-failure breadcrumbs end-to-end: the worker
 * ingests `.brigadir-channel/<runId>.jsonl` evidence as `channel_failure`
 * run-events at run exit and via the periodic reconciler; the exit/reconciler
 * race is settled by the filesystem rename-claim (no duplicate rows); active
 * runs' files are untouched; unattributable files age out via retention; run
 * status/outcome are NEVER modified by ingestion.
 */
describe('channel-failure breadcrumbs ingestion (feature 027, US3)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let reconciler: OutboxReconcileService;
  let env: ClaudeCliTestEnv;
  let scratch: string;
  let configRoot: string;
  let nextTicket = 700;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    scratch = await mkdtemp(join(tmpdir(), 'brigadir-channel-it-'));
    configRoot = join(scratch, 'cfg');
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;
    process.env.BRIGADIR_MCP_CONFIG_ROOT = configRoot;
    process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS = String(60 * 60_000); // dormant — driven manually
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
    reconciler = worker.get(OutboxReconcileService);
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

  async function plantBreadcrumbs(runId: string, records: Record<string, unknown>[]): Promise<string> {
    const file = channelBreadcrumbFilePath(configRoot, runId);
    await mkdir(channelBreadcrumbDirPath(configRoot), { recursive: true });
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  async function plantOutbox(runId: string, report: unknown): Promise<void> {
    await mkdir(join(configRoot, '.brigadir-outbox'), { recursive: true });
    await writeFile(
      outboxFilePath(configRoot, runId),
      JSON.stringify({ runId, outcome: 'success', report, timestamp: 't' }),
    );
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async function channelEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    const events = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    return events
      .filter((e) => e.type === CHANNEL_FAILURE_EVENT)
      .map((e) => e.payload as Record<string, unknown>);
  }

  async function seedRunRow(status: string, outcome: string | null = null): Promise<string> {
    const p = await seedPipeline(db.db, { ticketKey: `BRIG-${nextTicket++}` });
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        agentId: p.agentId,
        ticketId: p.ticketId,
        executorType: 'claude_cli',
        status: status as (typeof schema.runs.$inferInsert)['status'],
        outcome: outcome as (typeof schema.runs.$inferInsert)['outcome'],
      })
      .returning({ id: schema.runs.id });
    return run.id;
  }

  async function pollStatus(
    runId: string,
    want: (s: string) => boolean,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && want(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  const TERMINAL = (s: string): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(s);

  it('exit path ingests planted breadcrumbs as channel_failure events (source=exit), file consumed', async () => {
    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      { tool: 'sleep', ms: 2000 },
      { tool: 'stream', fixture: 'stream-no-report' },
    ] as Parameters<typeof setFakeClaudeCallbacks>[0]);
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, cancelPollMs: 150 }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] },
      ticketKey: `BRIG-${nextTicket++}`,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    const runId = res.runId;

    await pollStatus(runId, (s) => s === 'running');
    await plantOutbox(runId, VALID_REPORT); // rescue path finalizes 'succeeded'
    const file = await plantBreadcrumbs(runId, [
      record('report_progress', '2026-07-21T10:00:00.000Z'),
      record('complete_task', '2026-07-21T10:05:00.000Z'),
    ]);

    const row = await pollStatus(runId, TERMINAL);
    expect(row.status).toBe('succeeded');

    // Exit-path ingestion is best-effort after finalize — poll briefly.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await channelEvents(runId)).length < 2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const events = await channelEvents(runId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tool: 'report_progress',
      kind: 'network',
      attempts: 11,
      occurred_at: '2026-07-21T10:00:00.000Z',
      source: 'exit',
      target: '127.0.0.1:39999',
    });
    expect(await fileExists(file)).toBe(false);
    expect(await fileExists(`${file}.ingesting`)).toBe(false);
  }, 60_000);

  it('reconciler ingests an orphaned file for a terminal run (source=reconcile); status/outcome untouched', async () => {
    const runId = await seedRunRow('failed', null);
    const file = await plantBreadcrumbs(runId, [record('complete_task', '2026-07-21T11:00:00.000Z')]);

    await reconciler.run();

    const events = await channelEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'reconcile', tool: 'complete_task' });
    expect(await fileExists(file)).toBe(false);

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(row.status).toBe('failed'); // ingestion never writes status
    expect(row.outcome).toBeNull(); // ...or outcome
  });

  it('two concurrent reconcile passes produce NO duplicate rows (rename-claim race)', async () => {
    const runId = await seedRunRow('cancelled');
    await plantBreadcrumbs(runId, [
      record('report_progress', '2026-07-21T12:00:00.000Z'),
      record('report_progress', '2026-07-21T12:01:00.000Z'),
      record('complete_task', '2026-07-21T12:02:00.000Z'),
    ]);

    await Promise.all([reconciler.run(), reconciler.run()]);
    await reconciler.run(); // a third pass over the consumed file is a no-op

    const events = await channelEvents(runId);
    expect(events).toHaveLength(3); // exactly once, never doubled
  });

  it('an ACTIVE run’s file is left untouched by the reconciler', async () => {
    const runId = await seedRunRow('running');
    const file = await plantBreadcrumbs(runId, [record('report_progress', '2026-07-21T13:00:00.000Z')]);

    await reconciler.run();

    expect(await fileExists(file)).toBe(true);
    expect(await channelEvents(runId)).toHaveLength(0);
  });

  it('invalid lines are dropped, valid ones ingested', async () => {
    const runId = await seedRunRow('timed_out', null);
    await plantBreadcrumbs(runId, [record('report_progress', '2026-07-21T14:00:00.000Z')]);
    const file = channelBreadcrumbFilePath(configRoot, runId);
    await writeFile(file, `{broken json\n${JSON.stringify(record('complete_task', '2026-07-21T14:01:00.000Z'))}\n`, {
      flag: 'a',
    });

    await reconciler.run();

    const events = await channelEvents(runId);
    expect(events).toHaveLength(2); // 3 lines, 1 invalid dropped
  });

  it('a file for an unknown run is retained, then deleted past the retention window', async () => {
    const unknownRunId = randomUUID();
    const file = await plantBreadcrumbs(unknownRunId, [record('report_progress', '2026-07-21T15:00:00.000Z')]);

    await reconciler.run();
    expect(await fileExists(file)).toBe(true); // fresh — kept for inspection

    await utimes(file, new Date(1_000_000), new Date(1_000_000)); // ancient
    await reconciler.run();
    expect(await fileExists(file)).toBe(false); // aged out
    // Nothing was ever inserted for it.
    const dir = await readdir(channelBreadcrumbDirPath(configRoot));
    expect(dir.filter((n) => n.startsWith(unknownRunId))).toHaveLength(0);
  });
});

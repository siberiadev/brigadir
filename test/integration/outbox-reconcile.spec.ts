import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { OUTBOX_RECONCILE_QUEUE } from '@brigadir/queues';
import { outboxFilePath } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { OutboxReconcileService } from '../../apps/worker/src/outbox-reconcile.service';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const REPORT = { schema_version: 2, outcome: 'success', summary: 'rescued', checks: [{ name: 'build', status: 'pass' }] };

/**
 * Feature 026 (US3) — periodic outbox reconciler. Seeds runs in every matrix
 * state, plants outbox files, and drives ONE scan pass directly (no waiting on
 * the 60s scheduler). Verifies the resolution matrix, idempotence of a second
 * pass, retention of unresolvable files, and single-scheduler registration.
 */
describe('outbox reconciler (feature 026, US3)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let svc: OutboxReconcileService;
  let scratch: string;
  let configRoot: string;
  let nextTicket = 500;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'brigadir-recon-it-'));
    configRoot = join(scratch, 'cfg');
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
    process.env.BRIGADIR_MCP_CONFIG_ROOT = configRoot;
    // Keep the scheduler's own tick from racing our direct run() calls.
    process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS = String(60 * 60_000);

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    svc = worker.get(OutboxReconcileService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
    await rm(scratch, { recursive: true, force: true });
    delete process.env.BRIGADIR_MCP_CONFIG_ROOT;
    delete process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS;
  });

  async function seedRun(status: string, outcome: string | null = null): Promise<string> {
    const p = await seedPipeline(db.db, { ticketKey: `BRIG-${nextTicket++}` });
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        agentId: p.agentId,
        ticketId: p.ticketId,
        executorType: 'claude_cli',
        status,
        outcome,
      })
      .returning({ id: schema.runs.id });
    return run.id;
  }

  async function placeOutbox(runId: string, report: unknown = REPORT): Promise<string> {
    const file = outboxFilePath(configRoot, runId);
    await mkdir(join(configRoot, '.brigadir-outbox'), { recursive: true });
    await writeFile(file, JSON.stringify({ runId, outcome: 'success', report, timestamp: 't' }));
    return file;
  }

  async function statusOf(runId: string): Promise<{ status: string; outcome: string | null }> {
    const [row] = await db.db
      .select({ status: schema.runs.status, outcome: schema.runs.outcome })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    return row;
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  it('resolves the full matrix in one pass', async () => {
    const running = await seedRun('running');
    const failedNull = await seedRun('failed', null);
    const timedOutNull = await seedRun('timed_out', null);
    const failedResolved = await seedRun('failed', 'failure');
    const cancelled = await seedRun('cancelled');
    const awaiting = await seedRun('awaiting_human');
    const unknownRunId = '00000000-0000-4000-8000-000000000000';

    const files = {
      running: await placeOutbox(running),
      failedNull: await placeOutbox(failedNull),
      timedOutNull: await placeOutbox(timedOutNull),
      failedResolved: await placeOutbox(failedResolved),
      cancelled: await placeOutbox(cancelled),
      awaiting: await placeOutbox(awaiting),
      unknown: await placeOutbox(unknownRunId),
    };
    // A corrupt file that can never be resolved.
    const corruptFile = outboxFilePath(configRoot, 'corrupt-run');
    await writeFile(corruptFile, '{not valid json');

    await svc.run();

    // running / terminal-bad-null → rescued with the report outcome, consumed.
    expect(await statusOf(running)).toEqual({ status: 'succeeded', outcome: 'success' });
    expect(await statusOf(failedNull)).toEqual({ status: 'succeeded', outcome: 'success' });
    expect(await statusOf(timedOutNull)).toEqual({ status: 'succeeded', outcome: 'success' });
    expect(await fileExists(files.running)).toBe(false);
    expect(await fileExists(files.failedNull)).toBe(false);
    expect(await fileExists(files.timedOutNull)).toBe(false);
    // run_checks written for the rescued run.
    const checks = await db.db.select().from(schema.runChecks).where(eq(schema.runChecks.runId, running));
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('build');

    // Already-resolved terminal → untouched, file discarded.
    expect(await statusOf(failedResolved)).toEqual({ status: 'failed', outcome: 'failure' });
    expect(await fileExists(files.failedResolved)).toBe(false);

    // cancelled → status kept, report attached, file consumed.
    expect(await statusOf(cancelled)).toEqual({ status: 'cancelled', outcome: null });
    const cancelEvents = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, cancelled));
    const undelivered = cancelEvents.filter((e) => e.type === 'undelivered_report');
    expect(undelivered).toHaveLength(1);
    expect((undelivered[0].payload as { source: string }).source).toBe('periodic_reconcile');
    expect(await fileExists(files.cancelled)).toBe(false);

    // awaiting_human → untouched AND file KEPT (live completion path).
    expect(await statusOf(awaiting)).toEqual({ status: 'awaiting_human', outcome: null });
    expect(await fileExists(files.awaiting)).toBe(true);

    // unknown run id → discarded.
    expect(await fileExists(files.unknown)).toBe(false);

    // corrupt file → kept (retention will age it out later).
    expect(await fileExists(corruptFile)).toBe(true);

    // Second pass is a no-op: the only surviving resolvable file (awaiting_human)
    // is still skipped, and no new events appear anywhere.
    const eventsBefore = (await db.db.select().from(schema.runEvents)).length;
    await svc.run();
    const eventsAfter = (await db.db.select().from(schema.runEvents)).length;
    expect(eventsAfter).toBe(eventsBefore);
    expect(await statusOf(awaiting)).toEqual({ status: 'awaiting_human', outcome: null });
    expect(await fileExists(files.awaiting)).toBe(true);

    // Clean up the survivors so they don't leak into the retention test.
    await rm(files.awaiting, { force: true });
    await rm(corruptFile, { force: true });
  });

  it('a concurrent live callback wins the race; the reconciler is a no-op (idempotent)', async () => {
    const running = await seedRun('running');
    const file = await placeOutbox(running);
    // Simulate the live callback finalizing FIRST with an outcome.
    await db.db
      .update(schema.runs)
      .set({ status: 'succeeded', outcome: 'success', report: REPORT })
      .where(eq(schema.runs.id, running));

    await svc.run();

    // Status unchanged (already had an outcome) and the file is discarded.
    expect(await statusOf(running)).toEqual({ status: 'succeeded', outcome: 'success' });
    expect(await fileExists(file)).toBe(false);
  });

  it('retention deletes an unresolvable (corrupt) file for an existing run once it is older than the window', async () => {
    // A corrupt file whose run exists cannot be reconciled; it is kept for
    // inspection while fresh, then aged out by retention.
    const running = await seedRun('running');
    const corrupt = outboxFilePath(configRoot, running);
    await mkdir(join(configRoot, '.brigadir-outbox'), { recursive: true });
    await writeFile(corrupt, '{still not json');

    // Fresh → kept, run untouched.
    await svc.run();
    expect(await fileExists(corrupt)).toBe(true);
    expect(await statusOf(running)).toEqual({ status: 'running', outcome: null });

    // Backdate 8 days (> default 7-day retention) → deleted on next pass.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(corrupt, eightDaysAgo, eightDaysAgo);
    await svc.run();
    expect(await fileExists(corrupt)).toBe(false);
  });

  it('registers exactly one outbox-reconcile job scheduler', async () => {
    const queue = worker.get<Queue>(getQueueToken(OUTBOX_RECONCILE_QUEUE), { strict: false });
    const schedulers = await queue.getJobSchedulers();
    const outbox = schedulers.filter((s) => String(s.key).includes('outbox-reconcile'));
    expect(outbox).toHaveLength(1);
  });
});

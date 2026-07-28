import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const JWT_SECRET = 'callback-progress-test-jwt-secret';

/**
 * T111 (US3, FR-014/021) — report_progress lands ordered timeline events
 * without altering run status; a non-blocking request_human queues a task
 * without parking the run, and the run still finalizes normally.
 */
describe('progress events + non-blocking human notes (T111)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let backendUrl: string;
  let nextTicket = 800;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    const backendModule: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();
  }, 240_000);

  afterAll(async () => {
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function seedRunningRun(): Promise<{ runId: string; workspaceId: string; ticketKey: string }> {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, { executorType: 'mock', ticketKey });
    const [row] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
      })
      .returning({ id: schema.runs.id });
    return { runId: row.id, workspaceId: p.workspaceId, ticketKey };
  }

  function tokenFor(runId: string, workspaceId: string, ticketKey: string): string {
    return signRunToken(
      { sub: runId, wsp: workspaceId, tkt: ticketKey, exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
  }

  async function post(runId: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${backendUrl}/api/callbacks/runs/${runId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('two report_progress calls then complete: both land as ordered run_events, run still finalizes', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const p1 = await post(runId, 'progress', token, { stage: 'reading', message: 'Reading the ticket', percent: 10 });
    expect(p1.status).toBe(200);

    const p2 = await post(runId, 'progress', token, { stage: 'implementing', message: 'Writing the fix', percent: 60 });
    expect(p2.status).toBe(200);

    const complete = await post(runId, 'complete', token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'Done.',
      checks: [],
    });
    expect(complete.status).toBe(200);

    const events = await db.db
      .select()
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'progress')))
      .orderBy(schema.runEvents.id);

    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({ stage: 'reading', message: 'Reading the ticket', percent: 10 });
    expect(events[1].payload).toMatchObject({ stage: 'implementing', message: 'Writing the fix', percent: 60 });

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(row.status).toBe('succeeded');
  });

  it('a non-blocking request_human creates a task without parking the run, and the run still succeeds', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const humanRes = await post(runId, 'human', token, {
      kind: 'question',
      title: 'FYI: using the v2 endpoint',
      details: 'not blocking, just a note',
      blocking: false,
    });
    expect(humanRes.status).toBe(200);
    const humanBody = (await humanRes.json()) as { ok: boolean; blocking: boolean };
    expect(humanBody).toEqual({ ok: true, created: true, blocking: false });

    // Run must NOT be parked — the guard would reject a subsequent complete otherwise.
    const [midRun] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(midRun.status).toBe('running');

    const completeRes = await post(runId, 'complete', token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'Done, noted the endpoint choice.',
      checks: [],
    });
    expect(completeRes.status).toBe(200);

    const [finalRun] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(finalRun.status).toBe('succeeded');

    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ blocking: false, title: 'FYI: using the v2 endpoint' });
  });

  // feature 026 (FR-004/FR-022): a ~4000-char progress message is accepted and
  // persisted in full; a multi-paragraph human-request details survives intact.
  it('a 4000-char progress message persists in full, and request_human details keep full fidelity', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const longMessage = 'A'.repeat(4000);
    const p = await post(runId, 'progress', token, { stage: 'implementing', message: longMessage });
    expect(p.status).toBe(200);

    const [event] = await db.db
      .select()
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'progress')))
      .orderBy(schema.runEvents.id);
    expect((event.payload as { message: string }).message).toBe(longMessage);

    const details = '## Context\n\nFirst paragraph.\n\n- point one\n- point two\n\nSecond paragraph.';
    const humanRes = await post(runId, 'human', token, {
      kind: 'question',
      title: 'Multi-paragraph question',
      details,
      blocking: false,
    });
    expect(humanRes.status).toBe(200);
    const [task] = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, runId), eq(schema.humanTasks.title, 'Multi-paragraph question')));
    expect(task.details).toBe(details);
  });
});

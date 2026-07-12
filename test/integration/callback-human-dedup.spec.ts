import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const JWT_SECRET = 'callback-human-dedup-test-jwt-secret';

/**
 * T110 (US2, FR-020) — at most one open human task per run, whether it
 * arrives via two `request_human` calls or a `request_human` followed by a
 * `complete_task{needs_human}` reaching the SAME dedup guard from the
 * completion path.
 */
describe('needs_human / request_human dedup — at most one open task per run (T110)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let backendUrl: string;
  let nextTicket = 700;

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

  async function openTasksFor(runId: string): Promise<Array<typeof schema.humanTasks.$inferSelect>> {
    return db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, runId), eq(schema.humanTasks.status, 'open')));
  }

  it('two request_human calls for the same run end with at most one open task', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const first = await post(runId, 'human', token, {
      kind: 'question',
      title: 'First question',
      details: 'a',
      blocking: true,
    });
    expect(first.status).toBe(200);

    // Run is now awaiting_human, which the guard also accepts — a second
    // request_human (e.g. a retried tool call) must not create a 2nd task.
    const second = await post(runId, 'human', token, {
      kind: 'question',
      title: 'Second question',
      details: 'b',
      blocking: true,
    });
    expect(second.status).toBe(200);

    const open = await openTasksFor(runId);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('First question'); // the first one wins, not overwritten
  });

  it('a request_human followed by a complete_task{needs_human} still ends with at most one open task', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const humanRes = await post(runId, 'human', token, {
      kind: 'blocker',
      title: 'Blocked on credentials',
      details: 'need the staging key',
      blocking: true,
    });
    expect(humanRes.status).toBe(200);
    expect(await openTasksFor(runId)).toHaveLength(1);

    // The run is now awaiting_human — still an acceptable state for the
    // guard — so a (racing/duplicate) complete_task{needs_human} reaching
    // the OTHER dedup code path (RunsService.createHumanTask) must not add
    // a second open task.
    const completeRes = await post(runId, 'complete', token, {
      schema_version: 1,
      outcome: 'needs_human',
      summary: 'still stuck',
      checks: [],
      human_task: { kind: 'question', title: 'Should not be created', details: 'dup' },
    });
    expect(completeRes.status).toBe(200);

    const open = await openTasksFor(runId);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('Blocked on credentials'); // original still stands
  });
});

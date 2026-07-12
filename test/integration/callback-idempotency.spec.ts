import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const JWT_SECRET = 'callback-idempotency-test-jwt-secret';

/**
 * T106 (US1, FR-009, SC-007) — completion idempotency: the first valid
 * `complete_task` wins; any later completion for the same run is rejected as
 * a conflict and never mutates the finalized row or double-writes checks.
 */
describe('callback completion idempotency (T106)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let backendUrl: string;
  let nextTicket = 400;

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

  async function seedRun(status: string): Promise<{ runId: string; workspaceId: string; ticketKey: string }> {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, { executorType: 'mock', ticketKey });
    const [row] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status,
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

  async function complete(runId: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${backendUrl}/api/callbacks/runs/${runId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('the first complete wins; a second complete for the same run returns 409 and mutates nothing further', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('running');
    const token = tokenFor(runId, workspaceId, ticketKey);

    const firstBody = {
      schema_version: 1,
      outcome: 'success',
      summary: 'first report wins',
      checks: [{ name: 'tests_pass', status: 'pass' }],
    };
    const firstRes = await complete(runId, token, firstBody);
    expect(firstRes.status).toBe(200);

    const [afterFirst] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(afterFirst.status).toBe('succeeded');
    expect(afterFirst.report).toMatchObject({ summary: 'first report wins' });

    const secondBody = {
      schema_version: 1,
      outcome: 'failure',
      summary: 'a late duplicate — must not win',
      checks: [],
    };
    const secondRes = await complete(runId, token, secondBody);
    // By the time the second call arrives, the run is already 'succeeded' —
    // the guard's own state check (not just CallbackService's idempotency
    // check) rejects it first; either layer producing 409 satisfies SC-007.
    expect(secondRes.status).toBe(409);

    const [afterSecond] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    // First result stands, byte-for-byte.
    expect(afterSecond).toEqual(afterFirst);

    const checks = await db.db.select().from(schema.runChecks).where(eq(schema.runChecks.runId, runId));
    expect(checks).toHaveLength(1); // not double-written
  });

  it('concurrent completes for the same run: exactly one wins, checks written once (DB-guarded race)', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('running');
    const token = tokenFor(runId, workspaceId, ticketKey);

    const bodyA = { schema_version: 1, outcome: 'success', summary: 'racer A', checks: [{ name: 'a', status: 'pass' }] };
    const bodyB = { schema_version: 1, outcome: 'failure', summary: 'racer B', checks: [{ name: 'b', status: 'fail' }] };

    const [resA, resB] = await Promise.all([complete(runId, token, bodyA), complete(runId, token, bodyB)]);
    const statuses = [resA.status, resB.status].sort();
    // Exactly one 200 and one 409 — the DB-guarded UPDATE (not just the
    // guard's earlier read) is what actually arbitrates the race.
    expect(statuses).toEqual([200, 409]);

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(['succeeded', 'failed']).toContain(row.status);
    expect(row.report).toMatchObject({ summary: row.status === 'succeeded' ? 'racer A' : 'racer B' });

    const checks = await db.db.select().from(schema.runChecks).where(eq(schema.runChecks.runId, runId));
    expect(checks).toHaveLength(1); // only the winner's checks were written
  });

  it('a late complete arriving after the run timed out is rejected 409, no mutation', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('timed_out');
    const token = tokenFor(runId, workspaceId, ticketKey);

    const before = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    const res = await complete(runId, token, { schema_version: 1, outcome: 'success', summary: 'too late', checks: [] });

    expect(res.status).toBe(409);
    const after = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(after).toEqual(before);
  });
});

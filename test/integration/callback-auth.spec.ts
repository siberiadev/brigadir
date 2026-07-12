import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const JWT_SECRET = 'callback-auth-test-jwt-secret';

/**
 * T105 (US1, FR-003, SC-004) — mandatory auth matrix: mismatched, expired,
 * and finalized-run credentials are rejected 100% of the time and never
 * mutate stored state; a well-formed token for the acceptable `awaiting_human`
 * state IS accepted.
 */
describe('callback auth matrix (T105)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let backendUrl: string;
  let nextTicket = 300;

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

  function tokenFor(runId: string, workspaceId: string, ticketKey: string, expiresInSec = 3600, secret = JWT_SECRET): string {
    return signRunToken(
      { sub: runId, wsp: workspaceId, tkt: ticketKey, exp: Math.floor(Date.now() / 1000) + expiresInSec },
      secret,
    );
  }

  async function post(runId: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${backendUrl}/api/callbacks/runs/${runId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function runRow(runId: string): Promise<typeof schema.runs.$inferSelect> {
    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    return row;
  }

  it('a token minted for a DIFFERENT run is rejected and nothing is persisted', async () => {
    const target = await seedRun('running');
    const other = await seedRun('running');
    const tokenForOtherRun = tokenFor(other.runId, other.workspaceId, other.ticketKey);

    const before = await runRow(target.runId);
    const res = await post(target.runId, 'progress', tokenForOtherRun, { stage: 'x', message: 'y' });

    expect(res.status).toBe(401);
    const after = await runRow(target.runId);
    expect(after).toEqual(before);

    const events = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, target.runId));
    expect(events).toHaveLength(0);
  });

  it('an expired token is rejected and nothing is persisted', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('running');
    const expired = tokenFor(runId, workspaceId, ticketKey, -10);

    const before = await runRow(runId);
    const res = await post(runId, 'progress', expired, { stage: 'x', message: 'y' });

    expect(res.status).toBe(401);
    expect(await runRow(runId)).toEqual(before);
  });

  it('a token whose signature does not match the server secret is rejected', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('running');
    const badSig = tokenFor(runId, workspaceId, ticketKey, 3600, 'a-completely-wrong-secret');

    const res = await post(runId, 'progress', badSig, { stage: 'x', message: 'y' });
    expect(res.status).toBe(401);
  });

  it('a token for an already-finalized (succeeded) run is rejected and nothing is persisted', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('succeeded');
    const token = tokenFor(runId, workspaceId, ticketKey);

    const before = await runRow(runId);
    const res = await post(runId, 'complete', token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'late',
      checks: [],
    });

    expect(res.status).toBe(409);
    expect(await runRow(runId)).toEqual(before);
  });

  it('a token for a cancelled run is rejected', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('cancelled');
    const token = tokenFor(runId, workspaceId, ticketKey);
    const res = await post(runId, 'progress', token, { stage: 'x', message: 'y' });
    expect(res.status).toBe(409);
  });

  it('a token for a superseded run is rejected', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('superseded');
    const token = tokenFor(runId, workspaceId, ticketKey);
    const res = await post(runId, 'progress', token, { stage: 'x', message: 'y' });
    expect(res.status).toBe(409);
  });

  it('a well-formed token whose run is legitimately awaiting_human is ACCEPTED', async () => {
    const { runId, workspaceId, ticketKey } = await seedRun('awaiting_human');
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await post(runId, 'progress', token, { stage: 'still going', message: 'after resume context' });
    expect(res.status).toBe(200);

    const events = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    expect(events).toHaveLength(1);
  });
});

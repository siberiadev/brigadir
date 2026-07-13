import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T028 (US2, FR-012 / constitution rule #7): cancelling a `running` run flips it
 * to `cancelled`; cancelling an `awaiting_human` run is a guarded no-op
 * (`cancelled:false, reason:not_running`) — the parked state is NEVER overwritten.
 */
describe('run cancel guard (T028)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let p: Awaited<ReturnType<typeof seedPipeline>>;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    p = await seedPipeline(db.db);

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  const insertRun = async (status: string) => {
    const [r] = await db.db
      .insert(schema.runs)
      .values({ workspaceId: p.workspaceId, ticketId: p.ticketId, agentId: p.agentId, executorType: 'mock', status, attempt: 1 })
      .returning({ id: schema.runs.id });
    return r.id;
  };
  const statusOf = async (id: string) => (await db.db.select({ s: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, id)))[0].s;
  const cancel = (id: string) => fetch(`${url}/api/runs/${id}/cancel`, { method: 'POST', headers: authHeaders });

  it('cancels a running run', async () => {
    const id = await insertRun('running');
    const res = await cancel(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
    expect(await statusOf(id)).toBe('cancelled');
  });

  it('does NOT overwrite an awaiting_human run (guarded no-op)', async () => {
    const id = await insertRun('awaiting_human');
    const res = await cancel(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: false, reason: 'not_running' });
    expect(await statusOf(id)).toBe('awaiting_human'); // unchanged
  });

  it('a terminal run → cancelled:false, not_running', async () => {
    const id = await insertRun('succeeded');
    const body = await (await cancel(id)).json();
    expect(body).toEqual({ ok: true, cancelled: false, reason: 'not_running' });
  });

  it('unknown id → 404', async () => {
    const res = await cancel(randomUUID());
    expect(res.status).toBe(404);
  });
});

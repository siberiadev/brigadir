import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T029 (US2, FR-013): retry a finished run → a NEW run via the manual-trigger
 * path (all three idempotency layers intact); retry when an active run already
 * exists → 409 `active_run_exists`; unknown id → 404.
 */
describe('run retry via manual-trigger (T029)', () => {
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
  const retry = (id: string) => fetch(`${url}/api/runs/${id}/retry`, { method: 'POST', headers: authHeaders });

  it('retrying a finished run creates a new run', async () => {
    const finished = await insertRun('failed');
    const res = await retry(finished);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deduplicated).toBe(false);
    expect(body.run_id).toBeTruthy();
    expect(body.run_id).not.toBe(finished);

    const active = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, p.ticketId), eq(schema.runs.status, 'queued')));
    expect(active.length).toBe(1);
  });

  it('retry when an active run already exists → 409 active_run_exists', async () => {
    // The previous test left a queued (active) run for this (ticket, agent).
    const finished = await insertRun('failed');
    const res = await retry(finished);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('active_run_exists');
  });

  it('unknown id → 404', async () => {
    const res = await retry(randomUUID());
    expect(res.status).toBe(404);
  });
});

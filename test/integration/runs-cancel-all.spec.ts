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
 * Bulk stop (POST /api/workspaces/:id/runs/cancel-all): flips every `queued`
 * and `running` run of THE workspace to `cancelled` in one guarded UPDATE.
 * `awaiting_human` and terminal runs are untouched (constitution rule #7), and
 * another workspace's active runs are out of scope.
 */
describe('runs cancel-all (bulk stop)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let p: Awaited<ReturnType<typeof seedPipeline>>;
  let other: Awaited<ReturnType<typeof seedPipeline>>;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    p = await seedPipeline(db.db);
    other = await seedPipeline(db.db);

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

  const insertRun = async (seed: typeof p, status: string) => {
    const [r] = await db.db
      .insert(schema.runs)
      .values({ workspaceId: seed.workspaceId, ticketId: seed.ticketId, agentId: seed.agentId, executorType: 'mock', status, attempt: 1 })
      .returning({ id: schema.runs.id });
    return r.id;
  };
  const statusOf = async (id: string) => (await db.db.select({ s: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, id)))[0].s;
  const cancelAll = (wsId: string) =>
    fetch(`${url}/api/workspaces/${wsId}/runs/cancel-all`, { method: 'POST', headers: authHeaders });

  it('cancels queued + running, leaves awaiting_human/terminal/other-workspace runs alone', async () => {
    const queued = await insertRun(p, 'queued');
    const running = await insertRun(p, 'running');
    const parked = await insertRun(p, 'awaiting_human');
    const done = await insertRun(p, 'succeeded');
    const foreignRunning = await insertRun(other, 'running');

    const res = await cancelAll(p.workspaceId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled_count: 2 });

    expect(await statusOf(queued)).toBe('cancelled');
    expect(await statusOf(running)).toBe('cancelled');
    expect(await statusOf(parked)).toBe('awaiting_human'); // rule #7 — never clobbered
    expect(await statusOf(done)).toBe('succeeded');
    expect(await statusOf(foreignRunning)).toBe('running'); // out of scope

    // Cancelled rows are finished (finished_at stamped).
    const [row] = await db.db
      .select({ finishedAt: schema.runs.finishedAt })
      .from(schema.runs)
      .where(eq(schema.runs.id, running));
    expect(row.finishedAt).not.toBeNull();
  });

  it('is idempotent: a second call finds nothing active → cancelled_count 0', async () => {
    const res = await cancelAll(p.workspaceId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled_count: 0 });
  });

  it('unknown workspace → 404', async () => {
    const res = await cancelAll(randomUUID());
    expect(res.status).toBe(404);
  });
});

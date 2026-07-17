import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import {
  startDatabase,
  startRedis,
  seedPipeline,
  TEST_DASHBOARD_TOKEN,
  DbHarness,
  RedisHarness,
} from './harness';

/**
 * Feature 017 (US3/US4): GET /api/runs — the bounded cross-workspace listing.
 * `status` is REQUIRED (422 otherwise), `limit` is clamped, the composite
 * ordering is fixed (running longest-first → queued longest-waiting →
 * terminal newest-finished-first), and ticketless setup runs stay listed.
 */
describe('global runs listing (feature 017)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

  const ids: Record<string, string> = {};
  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const p1 = await seedPipeline(db.db, { ticketKey: 'BRIG-1' });
    const p2 = await seedPipeline(db.db, { ticketKey: 'CHK-1' });
    const [t3] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: p1.workspaceId, jiraKey: 'BRIG-2', jiraId: '10002', summary: 'Second' })
      .returning({ id: schema.tickets.id });
    const [t4] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: p2.workspaceId, jiraKey: 'CHK-2', jiraId: '10003', summary: 'Third' })
      .returning({ id: schema.tickets.id });

    const insertRun = async (v: typeof schema.runs.$inferInsert) => {
      const [row] = await db.db.insert(schema.runs).values(v).returning({ id: schema.runs.id });
      return row.id;
    };

    // Running: r1 started 30m ago (longest — first), r2 started 10m ago.
    ids.r1 = await insertRun({ workspaceId: p1.workspaceId, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'running', startedAt: hoursAgo(0.5), createdAt: hoursAgo(0.6) });
    ids.r2 = await insertRun({ workspaceId: p2.workspaceId, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock', status: 'running', startedAt: hoursAgo(1 / 6), createdAt: hoursAgo(0.2) });
    // Queued: q1 waiting 20m (first), q2 waiting 5m.
    ids.q1 = await insertRun({ workspaceId: p1.workspaceId, ticketId: t3.id, agentId: p1.agentId, executorType: 'mock', status: 'queued', createdAt: hoursAgo(1 / 3) });
    ids.q2 = await insertRun({ workspaceId: p2.workspaceId, ticketId: t4.id, agentId: p2.agentId, executorType: 'mock', status: 'queued', createdAt: hoursAgo(1 / 12) });
    // Terminal: f1 finished 1h ago, setup (ticketless) finished 2h ago,
    // t1 timed_out 5h ago, f2 finished 30h ago (outside the 24h window).
    ids.f1 = await insertRun({ workspaceId: p1.workspaceId, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'failed', startedAt: hoursAgo(1.2), finishedAt: hoursAgo(1), createdAt: hoursAgo(1.3) });
    ids.setup = await insertRun({ workspaceId: p2.workspaceId, ticketId: null, agentId: p2.agentId, executorType: 'mock', status: 'failed', startedAt: hoursAgo(2.2), finishedAt: hoursAgo(2), createdAt: hoursAgo(2.3) });
    ids.t1 = await insertRun({ workspaceId: p2.workspaceId, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock', status: 'timed_out', startedAt: hoursAgo(5.7), finishedAt: hoursAgo(5), createdAt: hoursAgo(5.8) });
    ids.f2 = await insertRun({ workspaceId: p1.workspaceId, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'failed', startedAt: hoursAgo(30.5), finishedAt: hoursAgo(30), createdAt: hoursAgo(30.6) });

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

  const list = (query: string) =>
    fetch(`${url}/api/runs?${query}`, { headers: authHeaders }).then((r) => r.json());

  it('422 without a status filter (unbounded listing is impossible)', async () => {
    const res = await fetch(`${url}/api/runs`, { headers: authHeaders });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues[0].path).toEqual(['status']);
  });

  it('422 on an empty or unknown status token', async () => {
    expect((await fetch(`${url}/api/runs?status=`, { headers: authHeaders })).status).toBe(422);
    expect(
      (await fetch(`${url}/api/runs?status=running,exploded`, { headers: authHeaders })).status,
    ).toBe(422);
  });

  it('422 on a finished_within outside the period enum', async () => {
    expect(
      (await fetch(`${url}/api/runs?status=failed&finished_within=48h`, { headers: authHeaders }))
        .status,
    ).toBe(422);
  });

  it('live query: running (longest first) then queued (longest-waiting first), cross-workspace', async () => {
    const body = await list('status=running,queued');
    expect(body.total).toBe(4);
    expect(body.items.map((i: { run_id: string }) => i.run_id)).toEqual([
      ids.r1,
      ids.r2,
      ids.q1,
      ids.q2,
    ]);
    // The cross-workspace dimension is present on every row.
    expect(body.items[0].workspace.name).toBe('test-ws');
    expect(body.items[0].started_at).toBeTruthy();
    expect(body.items[0].agent.name).toBe('implementer');
  });

  it('attention query (finished_within=24h): newest finished first, 30h-old failure excluded', async () => {
    const body = await list('status=failed,timed_out&finished_within=24h');
    expect(body.total).toBe(3);
    expect(body.items.map((i: { run_id: string }) => i.run_id)).toEqual([
      ids.f1,
      ids.setup,
      ids.t1,
    ]);
    expect(body.items.every((i: { finished_at: string | null }) => i.finished_at)).toBe(true);
    // The ticketless setup run stays listed with ticket: null.
    expect(body.items[1].ticket).toBeNull();
    // Ticketed rows carry key + summary + a stored-field deep link.
    expect(body.items[0].ticket).toMatchObject({ key: 'BRIG-1', summary: 'Test ticket' });
    expect(body.items[0].ticket.jira_url).toContain('/browse/BRIG-1');
  });

  it('without finished_within the 30h-old failure is included', async () => {
    const body = await list('status=failed,timed_out');
    expect(body.total).toBe(4);
    expect(body.items.map((i: { run_id: string }) => i.run_id)).toContain(ids.f2);
  });

  it('limit caps items but total stays the full match count', async () => {
    const body = await list('status=running,queued&limit=2');
    expect(body.items.length).toBe(2);
    expect(body.items.map((i: { run_id: string }) => i.run_id)).toEqual([ids.r1, ids.r2]);
    expect(body.total).toBe(4);
  });

  it('garbage/overflow limit falls back to the default instead of erroring', async () => {
    for (const bad of ['abc', '0', '9000']) {
      const res = await fetch(`${url}/api/runs?status=running,queued&limit=${bad}`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(4); // default 10 > 4 seeded
    }
  });

  it('requires the dashboard bearer (401)', async () => {
    expect((await fetch(`${url}/api/runs?status=running`)).status).toBe(401);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T030 (US1, FR-001..FR-006/SC-004): GET the queue open (oldest-first) & closed
 * (resolved_at desc); GET count; resolve (now GUARDED — T035) with `resume` on a
 * blocking task creates a new attempt and closes the task.
 */
describe('human queue list/count/resolve (T030)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let p: Awaited<ReturnType<typeof seedPipeline>>;
  let parkedRunId: string;
  let resumeTaskId: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    p = await seedPipeline(db.db);

    const [parked] = await db.db
      .insert(schema.runs)
      .values({ workspaceId: p.workspaceId, ticketId: p.ticketId, agentId: p.agentId, executorType: 'mock', status: 'awaiting_human', attempt: 1 })
      .returning({ id: schema.runs.id });
    parkedRunId = parked.id;

    // Two open tasks (oldest-first) + one closed task.
    const [resume] = await db.db
      .insert(schema.humanTasks)
      .values({
        workspaceId: p.workspaceId, ticketId: p.ticketId, runId: parkedRunId, kind: 'blocker',
        title: 'Which DB?', details: 'postgres or mysql', blocking: true, status: 'open',
        createdAt: new Date('2026-07-12T08:00:00.000Z'),
      })
      .returning({ id: schema.humanTasks.id });
    resumeTaskId = resume.id;

    await db.db.insert(schema.humanTasks).values({
      workspaceId: p.workspaceId, ticketId: p.ticketId, kind: 'question',
      title: 'Newer', blocking: false, status: 'open',
      createdAt: new Date('2026-07-12T09:00:00.000Z'),
    });

    await db.db.insert(schema.humanTasks).values({
      workspaceId: p.workspaceId, ticketId: p.ticketId, kind: 'review',
      title: 'Done one', blocking: false, status: 'resolved',
      resolution: 'looks good', resolvedBy: 'dima', resolvedAt: new Date('2026-07-11T00:00:00.000Z'),
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
    });

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

  it('GET list open → oldest-first, with ticket + agent derived from the blocked run', async () => {
    const body = await fetch(`${url}/api/human-tasks?status=open`, { headers: authHeaders }).then((r) => r.json());
    expect(body.items.map((t: { title: string }) => t.title)).toEqual(['Which DB?', 'Newer']);
    const first = body.items[0];
    expect(first.blocking).toBe(true);
    expect(first.ticket.jira_url).toContain('/browse/');
    expect(first.agent?.name).toBe('implementer'); // via the parked run
    expect(first.run_id).toBe(parkedRunId);
    expect(first.status).toBeUndefined(); // open list omits closed-only fields
  });

  it('GET list closed → resolved_at desc, with resolution + resolver', async () => {
    const body = await fetch(`${url}/api/human-tasks?status=closed`, { headers: authHeaders }).then((r) => r.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ status: 'resolved', resolution: 'looks good', resolved_by: 'dima' });
    // Единый пагинированный конверт (реш. 2026-07-15); total считается по status-фильтру.
    expect(body).toMatchObject({ page: 1, page_size: 10, total: 1 });
  });

  it('GET count → open count', async () => {
    const body = await fetch(`${url}/api/human-tasks/count`, { headers: authHeaders }).then((r) => r.json());
    expect(body.open).toBe(2);
  });

  it('resolve is guarded — no bearer → 401', async () => {
    const res = await fetch(`${url}/api/human-tasks/${resumeTaskId}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }),
    });
    expect(res.status).toBe(401);
  });

  it('resolve resume on a blocking task creates a new attempt and closes the task', async () => {
    const res = await fetch(`${url}/api/human-tasks/${resumeTaskId}/resolve`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ action: 'resume', answer: 'use postgres', resolved_by: 'dima' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: 'resume' });
    expect(body.newRunId).toBeTruthy();

    // task closed
    const [task] = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.id, resumeTaskId));
    expect(task.status).toBe('resolved');
    // new attempt seeded (attempt 2, carrying the human answer)
    const [newRun] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, body.newRunId));
    expect(newRun.attempt).toBe(2);
    // the parked run was superseded
    const [parked] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, parkedRunId));
    expect(parked.status).toBe('superseded');
    // count now reflects one fewer open task
    const count = await fetch(`${url}/api/human-tasks/count`, { headers: authHeaders }).then((r) => r.json());
    expect(count.open).toBe(1);
  });
});

/**
 * Workspace-scoped Human queue tab: `GET /api/human-tasks?workspace=<id>` filters
 * the same list to one workspace (open & closed), while the unfiltered list stays
 * global. Isolated seed (two workspaces) so it doesn't touch the global-count
 * assertions above.
 */
describe('human queue workspace filter', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let wsA: Awaited<ReturnType<typeof seedPipeline>>;
  let wsB: Awaited<ReturnType<typeof seedPipeline>>;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    wsA = await seedPipeline(db.db, { ticketKey: 'AAA-1' });
    wsB = await seedPipeline(db.db, { ticketKey: 'BBB-1' });

    // wsA: one open + one closed. wsB: one open.
    await db.db.insert(schema.humanTasks).values({
      workspaceId: wsA.workspaceId, ticketId: wsA.ticketId, kind: 'question',
      title: 'A open', blocking: false, status: 'open', createdAt: new Date('2026-07-12T08:00:00.000Z'),
    });
    await db.db.insert(schema.humanTasks).values({
      workspaceId: wsA.workspaceId, ticketId: wsA.ticketId, kind: 'review',
      title: 'A closed', blocking: false, status: 'resolved',
      resolution: 'ok', resolvedBy: 'dima', resolvedAt: new Date('2026-07-11T00:00:00.000Z'),
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    await db.db.insert(schema.humanTasks).values({
      workspaceId: wsB.workspaceId, ticketId: wsB.ticketId, kind: 'question',
      title: 'B open', blocking: false, status: 'open', createdAt: new Date('2026-07-12T09:00:00.000Z'),
    });

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

  it('open list scoped to a workspace returns only its tasks', async () => {
    const body = await fetch(`${url}/api/human-tasks?status=open&workspace=${wsA.workspaceId}`, { headers: authHeaders }).then((r) => r.json());
    expect(body.items.map((t: { title: string }) => t.title)).toEqual(['A open']);
    expect(body.total).toBe(1);
    expect(body.items[0].workspace.id).toBe(wsA.workspaceId);
  });

  it('closed list scoped to a workspace returns only its tasks', async () => {
    const body = await fetch(`${url}/api/human-tasks?status=closed&workspace=${wsA.workspaceId}`, { headers: authHeaders }).then((r) => r.json());
    expect(body.items.map((t: { title: string }) => t.title)).toEqual(['A closed']);
    expect(body.total).toBe(1);

    // wsB has no closed tasks → empty scoped list.
    const empty = await fetch(`${url}/api/human-tasks?status=closed&workspace=${wsB.workspaceId}`, { headers: authHeaders }).then((r) => r.json());
    expect(empty.items).toHaveLength(0);
    expect(empty.total).toBe(0);
  });

  it('unfiltered list stays global across workspaces', async () => {
    const body = await fetch(`${url}/api/human-tasks?status=open`, { headers: authHeaders }).then((r) => r.json());
    expect(body.items.map((t: { title: string }) => t.title).sort()).toEqual(['A open', 'B open']);
    expect(body.total).toBe(2);
  });
});

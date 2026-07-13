import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T025 (US3, FR-015/FR-016): GET runs — agent/status/ticket-key filters,
 * pagination reflects the FILTERED total, `created_at desc`, empty workspace →
 * `items: []`.
 */
describe('runs table list (T025)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let workspaceId: string;
  let agentA: string;
  let agentB: string;
  let ticket1: string;
  let ticket2: string;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const p = await seedPipeline(db.db, { ticketKey: 'BRIG-1' });
    workspaceId = p.workspaceId;
    agentA = p.agentId;
    ticket1 = p.ticketId;

    const [a2] = await db.db
      .insert(schema.agents)
      .values({ workspaceId, executorId: p.executorId, name: 'reviewer', instruction: 'x', statusSuccess: 'Done', statusFailure: 'Blocked' })
      .returning({ id: schema.agents.id });
    agentB = a2.id;
    const [t2] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: 'BRIG-2', jiraId: '2', summary: 'second' })
      .returning({ id: schema.tickets.id });
    ticket2 = t2.id;

    // 3 runs, deterministic created_at ordering (desc → r3, r2, r1).
    const mk = (agentId: string, ticketId: string, status: string, iso: string) =>
      db.db.insert(schema.runs).values({
        workspaceId, ticketId, agentId, executorType: 'mock', status, attempt: 1,
        createdAt: new Date(iso),
      });
    await mk(agentA, ticket1, 'succeeded', '2026-07-10T00:00:00.000Z'); // r1
    await mk(agentB, ticket2, 'failed', '2026-07-11T00:00:00.000Z'); // r2
    await mk(agentA, ticket1, 'running', '2026-07-12T00:00:00.000Z'); // r3

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

  const listRuns = (qs = '') =>
    fetch(`${url}/api/workspaces/${workspaceId}/runs${qs}`, { headers: authHeaders }).then((r) => r.json());

  it('lists all runs, created_at desc', async () => {
    const body = await listRuns();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items[0].status).toBe('running'); // newest
    expect(body.items[2].status).toBe('succeeded'); // oldest
    expect(body.items[0].ticket.jira_url).toContain('/browse/BRIG-1');
  });

  it('filters by agent; total reflects the filtered set', async () => {
    const body = await listRuns(`?agent=${agentB}`);
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].agent.name).toBe('reviewer');
  });

  it('filters by status', async () => {
    const body = await listRuns('?status=succeeded');
    expect(body.total).toBe(1);
    expect(body.items[0].status).toBe('succeeded');
  });

  it('filters by ticket-key substring (case-insensitive)', async () => {
    const body = await listRuns('?ticket=brig-2');
    expect(body.total).toBe(1);
    expect(body.items[0].ticket.key).toBe('BRIG-2');
  });

  it('paginates and reflects the filtered total', async () => {
    const page1 = await listRuns('?page=1&page_size=2');
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page1.page_size).toBe(2);
    const page2 = await listRuns('?page=2&page_size=2');
    expect(page2.items).toHaveLength(1);
  });

  it('an empty workspace returns items: [] (not an error)', async () => {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({ name: 'empty', jiraSiteUrl: 'https://x.atlassian.net', jiraProjectKey: 'X', jiraCredentials: Buffer.from('p') })
      .returning({ id: schema.workspaces.id });
    const res = await fetch(`${url}/api/workspaces/${ws.id}/runs`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});

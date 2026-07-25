import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { WaitingListResponseSchema } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * Feature 022, US3 (T020): GET /api/workspaces/:id/waiting — paginated envelope
 * via the mandatory factory schema, canonical order (priority_id ASC NULLS
 * LAST, jira_key ASC), released tickets disappear, unknown workspace → 404.
 */
describe('waiting-tickets endpoint (feature 022, US3)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let jira: MockJira;
  let workspaceId: string;

  const headers = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    jira?.server.close();
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(async () => {
    await db.db.delete(schema.runEvents);
    await db.db.delete(schema.runs);
    await db.db.delete(schema.workspaces); // cascades tickets
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;
  });

  async function seedWaiting(
    jiraKey: string,
    over: Partial<typeof schema.tickets.$inferInsert> = {},
  ): Promise<string> {
    const [t] = await db.db
      .insert(schema.tickets)
      .values({
        workspaceId,
        jiraKey,
        jiraId: '10000',
        summary: `summary ${jiraKey}`,
        lastSeenStatus: 'Ready for Dev',
        blockedBy: ['BRIG-1'],
        blockedState: 'waiting',
        ...over,
      })
      .returning({ id: schema.tickets.id });
    return t.id;
  }

  it('returns the canonical order and the factory envelope; drained rows disappear', async () => {
    // Deliberately seeded out of order: none < low(4) < high(2) is WRONG order —
    // response must come back high, low, none (priority ASC NULLS LAST).
    const idNone = await seedWaiting('BRIG-30');
    await seedWaiting('BRIG-20', { priorityId: 4, priorityName: 'Low', blockedState: 'dead_end' });
    await seedWaiting('BRIG-10', { priorityId: 2, priorityName: 'High', blockedBy: ['BRIG-1', 'BRIG-2'] });
    // A non-waiting ticket must not appear at all.
    await db.db.insert(schema.tickets).values({ workspaceId, jiraKey: 'BRIG-99', jiraId: '1', summary: 'x' });

    const res = await fetch(`${url}/api/workspaces/${workspaceId}/waiting`, { headers });
    expect(res.status).toBe(200);
    const body = WaitingListResponseSchema.parse(await res.json());
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.items.map((i) => i.jira_key)).toEqual(['BRIG-10', 'BRIG-20', 'BRIG-30']);
    expect(body.items[0].blocked_by).toEqual(['BRIG-1', 'BRIG-2']);
    expect(body.items[0].jira_url).toContain('/browse/BRIG-10');
    expect(body.items[1].blocked_state).toBe('dead_end');
    expect(body.items[2].priority_id).toBeNull();

    // Release: clearing the cache removes the row from the list.
    await db.db
      .update(schema.tickets)
      .set({ blockedBy: null, blockedState: null })
      .where(eq(schema.tickets.id, idNone));
    const drained = WaitingListResponseSchema.parse(
      await (await fetch(`${url}/api/workspaces/${workspaceId}/waiting`, { headers })).json(),
    );
    expect(drained.total).toBe(2);
    expect(drained.items.map((i) => i.jira_key)).toEqual(['BRIG-10', 'BRIG-20']);
  });

  it('paginates with page/page_size and keeps the deterministic order across pages', async () => {
    for (let i = 1; i <= 12; i += 1) {
      await seedWaiting(`BRIG-${String(i).padStart(3, '0')}`, { priorityId: 3 });
    }
    const p1 = WaitingListResponseSchema.parse(
      await (await fetch(`${url}/api/workspaces/${workspaceId}/waiting?page=1&page_size=10`, { headers })).json(),
    );
    const p2 = WaitingListResponseSchema.parse(
      await (await fetch(`${url}/api/workspaces/${workspaceId}/waiting?page=2&page_size=10`, { headers })).json(),
    );
    expect(p1.total).toBe(12);
    expect(p1.items).toHaveLength(10);
    expect(p2.items.map((i) => i.jira_key)).toEqual(['BRIG-011', 'BRIG-012']);
  });

  it('unknown workspace → 404', async () => {
    const res = await fetch(`${url}/api/workspaces/00000000-0000-0000-0000-000000000000/waiting`, { headers });
    expect(res.status).toBe(404);
  });
});

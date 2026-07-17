import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema, patchWorkspaceSettings } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import type { JiraBoardType } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * Live-Jira "preview ticket count" endpoint (POST /api/workspaces/:id/ticket-count).
 * Reuses the poller's scope builder, so it must mirror board semantics:
 *  - kanban → whole project (+ optional scope_jql), no sprint clause;
 *  - scrum with an active sprint → scoped to that sprint;
 *  - scrum with NO active sprint → idle (count 0, active_sprint null);
 *  - an optional `status` narrows to the agent-trigger set;
 *  - workspaces.settings.scope_jql is ANDed in.
 */
describe('workspace ticket-count preview', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let jira: MockJira;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

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
    jira.reset();
    await db.db.delete(schema.workspaces);
  });

  async function seedWorkspace(boardType: JiraBoardType): Promise<string> {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: boardType,
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  }

  const count = (id: string, body: unknown = {}) =>
    fetch(`${url}/api/workspaces/${id}/ticket-count`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    });

  it('kanban → whole project, no sprint clause; status narrows the count', async () => {
    const id = await seedWorkspace('kanban');
    jira.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    jira.seedIssue('BRIG-2', { status: 'Ready for Dev' });
    jira.seedIssue('BRIG-3', { status: 'Backlog' });

    const all = await count(id);
    expect(all.status).toBe(200);
    const allBody = await all.json();
    expect(allBody.count).toBe(3);
    expect(allBody.active_sprint).toBeNull();
    expect(allBody.jql).not.toMatch(/sprint/i);

    const scoped = await count(id, { status: 'Ready for Dev' });
    const scopedBody = await scoped.json();
    expect(scopedBody.count).toBe(2);
    expect(scopedBody.jql).toMatch(/status = "Ready for Dev"/);
  });

  it('scrum with an active sprint → scoped to that sprint', async () => {
    const id = await seedWorkspace('scrum');
    jira.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    jira.seedIssue('BRIG-2', { status: 'Ready for Dev' });
    jira.startSprint(100, ['BRIG-1']); // only BRIG-1 joins the active sprint

    const res = await count(id);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.active_sprint).toEqual({ id: 100 });
    expect(body.jql).toMatch(/sprint in \(100\)/);
  });

  it('scrum with NO active sprint → idle (count 0, active_sprint null)', async () => {
    const id = await seedWorkspace('scrum');
    jira.seedIssue('BRIG-1', { status: 'Ready for Dev' });

    const res = await count(id);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.active_sprint).toBeNull();
  });

  it('workspaces.settings.scope_jql is ANDed into the scope', async () => {
    const id = await seedWorkspace('kanban');
    await patchWorkspaceSettings(db.db, id, { scope_jql: 'labels = ai-ready' });
    jira.seedIssue('BRIG-1', { status: 'Ready for Dev', labels: ['ai-ready'] });
    jira.seedIssue('BRIG-2', { status: 'Ready for Dev' }); // no label → excluded

    const res = await count(id);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.jql).toMatch(/labels = ai-ready/);
  });

  it('unknown workspace → 404', async () => {
    const res = await count('00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

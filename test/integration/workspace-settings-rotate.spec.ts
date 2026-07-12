import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials, decodeJiraCredentials } from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const DAY = 24 * 60 * 60 * 1000;

/**
 * T141 (US4 acceptance, SC-008): rotation re-verifies live and replaces the
 * encrypted blob + expires_at (a re-verify failure keeps the old creds, 422);
 * settings edits persist; the server-derived credential_status badges at the
 * 30/7/expired thresholds.
 */
describe('workspace settings + rotation + expiry badge (T141)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let jira: MockJira;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

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

  async function seedWorkspace(expiresAt: Date | null): Promise<string> {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: `ws-${Math.random().toString(36).slice(2)}`,
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraCredentials: encodeJiraCredentials({ email: 'old@acme.io', api_token: 'old-token' }),
        jiraCredentialExpiresAt: expiresAt,
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  }

  it('rotation re-verifies and replaces the encrypted blob + expires_at', async () => {
    const id = await seedWorkspace(new Date(Date.now() + 100 * DAY));
    jira.expectAuth('new@acme.io', 'new-token');

    const res = await fetch(`${url}/api/workspaces/${id}/jira-connection`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        jira_email: 'new@acme.io',
        jira_api_token: 'new-token',
        expires_at: '2028-01-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    expect(Buffer.from(row.jiraCredentials as Buffer)[0]).toBe(0x01);
    expect(decodeJiraCredentials(row.jiraCredentials as Buffer)).toEqual({ email: 'new@acme.io', api_token: 'new-token' });
    expect(row.jiraCredentialExpiresAt?.toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });

  it('a re-verify failure keeps the OLD credentials (422)', async () => {
    const id = await seedWorkspace(new Date(Date.now() + 100 * DAY));
    jira.expectAuth('someone@else.io', 'their-token'); // the submitted creds won't match

    const res = await fetch(`${url}/api/workspaces/${id}/jira-connection`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        jira_email: 'new@acme.io',
        jira_api_token: 'wrong-token',
        expires_at: '2028-01-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(422);

    const [row] = await db.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    expect(decodeJiraCredentials(row.jiraCredentials as Buffer)).toEqual({ email: 'old@acme.io', api_token: 'old-token' });
  });

  it('settings edits persist (scope_jql / branch_prefix / repositories)', async () => {
    const id = await seedWorkspace(null);
    const res = await fetch(`${url}/api/workspaces/${id}/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope_jql: 'labels = ai',
        branch_prefix: 'feat',
        repositories: [{ name: 'api', git_url: 'git@x:api.git', default_branch: 'main' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repositories).toHaveLength(1);

    const [row] = await db.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    const settings = row.settings as { scope_jql?: string; branch_prefix?: string };
    expect(settings.scope_jql).toBe('labels = ai');
    expect(settings.branch_prefix).toBe('feat');
  });

  it('credential_status badges at 30/7/expired thresholds', async () => {
    const warn30 = await seedWorkspace(new Date(Date.now() + 25 * DAY));
    const warn7 = await seedWorkspace(new Date(Date.now() + 5 * DAY));
    const expired = await seedWorkspace(new Date(Date.now() - 1 * DAY));

    const list = await (await fetch(`${url}/api/workspaces`, { headers })).json();
    const byId = new Map<string, string>(list.map((w: { id: string; credential_status: string }) => [w.id, w.credential_status]));
    expect(byId.get(warn30)).toBe('warn_30');
    expect(byId.get(warn7)).toBe('warn_7');
    expect(byId.get(expired)).toBe('expired');
  });
});

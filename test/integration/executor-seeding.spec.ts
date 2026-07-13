import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const GOOD = { email: 'bot@acme.com', token: 'good-token' };

/**
 * T007 (US4, FR-022/SC-006): creating a workspace seeds EXACTLY one `claude_cli`
 * "claude" (repository = workspace default repo when present) + one `mock`
 * "mock". The picker is never empty for a fresh workspace.
 */
describe('executor default seeding on workspace create (T007)', () => {
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
    jira.expectAuth(GOOD.email, GOOD.token);
    await db.db.delete(schema.workspaces);
  });

  const create = (body: unknown) =>
    fetch(`${url}/api/workspaces`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });

  it('seeds exactly one claude_cli "claude" + one mock "mock"; claude.repository = default repo', async () => {
    const res = await create({
      name: 'Acme',
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      expires_at: '2027-07-12T00:00:00.000Z',
      board: '42',
      repositories: [{ name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' }],
    });
    expect(res.status).toBe(201);
    const ws = await res.json();

    const rows = await db.db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.workspaceId, ws.id));
    expect(rows).toHaveLength(2);

    const claude = rows.find((r) => r.type === 'claude_cli');
    const mock = rows.find((r) => r.type === 'mock');
    expect(claude?.name).toBe('claude');
    expect(mock?.name).toBe('mock');
    // repository = the workspace default repo (stored camelCase in config jsonb)
    expect((claude?.config as { repository?: string }).repository).toBe('api');
  });

  it('a workspace with no repositories seeds claude with an empty repository', async () => {
    const res = await create({
      name: 'NoRepo',
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      expires_at: '2027-07-12T00:00:00.000Z',
      board: '42',
      repositories: [],
    });
    expect(res.status).toBe(201);
    const ws = await res.json();
    const rows = await db.db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.workspaceId, ws.id));
    expect(rows).toHaveLength(2);
    const claude = rows.find((r) => r.type === 'claude_cli');
    expect((claude?.config as { repository?: string }).repository).toBe('');
  });
});

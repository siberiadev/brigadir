import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const GOOD = { email: 'bot@acme.com', token: 'good-token' };

/**
 * Platform-scoped executors (2026-07-13): creating a workspace seeds NO
 * executors — the global type-scoped bootstrap backfill (see
 * executor-backfill.spec) is the only default-seeding path, and it never
 * duplicates a type that already exists.
 */
describe('workspace creation does not seed executors', () => {
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
    await db.db.delete(schema.executors);
  });

  it('POST /api/workspaces creates the workspace and inserts zero executor rows', async () => {
    // The bootstrap backfill already ran at app init against the (then-empty)
    // suite DB; the beforeEach wipe leaves the table empty, so any row after
    // the create would have to come from the create path itself.
    const res = await fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Acme',
        jira_site_url: jira.baseUrl,
        jira_email: GOOD.email,
        jira_api_token: GOOD.token,
        expires_at: '2027-07-12T00:00:00.000Z',
        board: '42',
        repositories: [{ name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' }],
      }),
    });
    expect(res.status).toBe(201);

    const rows = await db.db.select().from(schema.executors);
    expect(rows).toHaveLength(0);
  });
});

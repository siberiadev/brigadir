import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials, decodeJiraCredentials, JIRA_CLIENT, type JiraClient } from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * T138 (mandatory — rotation E2E, task (e); R6 seam): the worker-side
 * LazyJiraClient is warmed with credentials A; a rotation to B via the backend
 * (PUT /api/workspaces/:id/jira-connection) must reach the worker's client on
 * its NEXT call (fingerprint rebuild across the process boundary) — the stale A
 * token must never keep authenticating — and the stored blob is the new `0x01`
 * envelope with the updated expires_at.
 */
describe('token rotation invalidates the memoized client (T138)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let worker: TestingModule;
  let jira: MockJira;
  let workspaceId: string;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: encodeJiraCredentials({ email: 'a@acme.io', api_token: 'token-A' }),
        jiraCredentialExpiresAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

    const backendModule: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
  }, 300_000);

  afterAll(async () => {
    jira?.server.close();
    await worker?.close();
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('the worker uses the rotated token B on its next call, not stale A', async () => {
    const workerJira = worker.get<JiraClient>(JIRA_CLIENT, { strict: false });
    const backendUrl = await backend.getUrl();

    // 1. Warm the worker client with credentials A (only A is accepted now).
    jira.expectAuth('a@acme.io', 'token-A');
    await expect(workerJira.getMyself()).resolves.toEqual({ displayName: 'BRIGADIR Bot' });

    // 2. Rotate to B via the backend. Only B is accepted from here on — the
    //    rotate's own re-verify uses B (JiraClientFactory), so it must pass.
    jira.expectAuth('b@acme.io', 'token-B');
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/jira-connection`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        jira_email: 'b@acme.io',
        jira_api_token: 'token-B',
        expires_at: '2028-06-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(200);

    // 3. The worker's NEXT call must authenticate with B (memo rebuilt via the
    //    changed fingerprint). If it were still A, mock /myself would 401 → throw.
    await expect(workerJira.getMyself()).resolves.toEqual({ displayName: 'BRIGADIR Bot' });

    // 4. The stored blob is the new 0x01 envelope with the updated expiry.
    const [row] = await db.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    expect(Buffer.from(row.jiraCredentials as Buffer)[0]).toBe(0x01);
    expect(decodeJiraCredentials(row.jiraCredentials as Buffer)).toEqual({ email: 'b@acme.io', api_token: 'token-B' });
    expect(row.jiraCredentialExpiresAt?.toISOString()).toBe('2028-06-01T00:00:00.000Z');
  });
});

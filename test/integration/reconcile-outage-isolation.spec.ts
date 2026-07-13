import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials, JiraClientFactory } from '@brigadir/jira';
import { ReconcileService } from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';

/**
 * T019 (US5, FR-029): two enabled workspaces where A's Jira client resolution
 * fails (a credential-decode / outage failure) — B's pass STILL completes; A is
 * logged and skipped for that pass only, and the pass does not throw.
 */
describe('multi-workspace reconcile: one workspace outage isolated (T019)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let factory: JiraClientFactory;
  let wsA: string;
  let wsB: string;

  const creds = () => encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' });

  const insertWs = async (name: string) => {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name,
        jiraSiteUrl: BASE,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: creds(),
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    mock.seedIssue('BRIG-1', { status: 'Ready for Dev' });

    wsA = await insertWs('A-outage');
    wsB = await insertWs('B-healthy');

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    reconcile = worker.get(ReconcileService, { strict: false });
    factory = worker.get(JiraClientFactory, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  const ticketCount = async (workspaceId: string) => {
    const rows = await db.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.workspaceId, workspaceId));
    return rows.length;
  };

  it("A's client resolution throws → B still completes; the pass does not throw", async () => {
    const real = factory.forWorkspace.bind(factory);
    const spy = vi
      .spyOn(factory, 'forWorkspace')
      .mockImplementation((id: string) =>
        id === wsA ? Promise.reject(new Error('workspace A: credential decode failed')) : real(id),
      );

    await expect(reconcile.run()).resolves.toBeUndefined();

    expect(await ticketCount(wsA)).toBe(0); // A skipped for this pass
    expect(await ticketCount(wsB)).toBeGreaterThan(0); // B unaffected
    spy.mockRestore();
  });
});

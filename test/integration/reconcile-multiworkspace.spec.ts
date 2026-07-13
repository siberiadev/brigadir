import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { ReconcileService } from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';

/**
 * T018 (US5, FR-026/FR-028): one reconcile pass polls EVERY enabled workspace
 * and skips a disabled one (`settings.enabled === false`) entirely.
 */
describe('multi-workspace reconcile: enabled polled, disabled skipped (T018)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let wsA: string;
  let wsB: string;
  let wsDisabled: string;

  const creds = () => encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' });

  const insertWs = async (name: string, enabled: boolean | undefined) => {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name,
        jiraSiteUrl: BASE,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: creds(),
        settings: enabled === undefined ? {} : { enabled },
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

    wsA = await insertWs('A-enabled-implicit', undefined); // no `enabled` key ⇒ enabled
    wsB = await insertWs('B-enabled-explicit', true);
    wsDisabled = await insertWs('C-disabled', false);

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    reconcile = worker.get(ReconcileService, { strict: false });
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

  it('one pass polls both enabled workspaces and skips the disabled one entirely', async () => {
    await reconcile.run();
    expect(await ticketCount(wsA)).toBeGreaterThan(0);
    expect(await ticketCount(wsB)).toBeGreaterThan(0);
    expect(await ticketCount(wsDisabled)).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
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
 * Lazy board introspection wired into reconcile (closes the phase-1-3 deviation).
 * Boot stays credential-free; at the start of a pass, a NULL `jira_board_type`
 * is introspected once via the Agile API and persisted. Introspection failure
 * skips the pass with a logged diagnostic (no crash, no busy-retry) and the next
 * pass retries.
 */
describe('reconcile lazy board introspection', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let workspaceId: string;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    // The mock board 42 is scrum; unknown board ids 404.
    mock = mockJira({ baseUrl: BASE, boardType: 'scrum', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: BASE,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: null, // unknown until introspected
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

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

  async function boardType(): Promise<string | null> {
    const [ws] = await db.db
      .select({ boardType: schema.workspaces.jiraBoardType })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    return ws.boardType;
  }

  it('populates jira_board_type on the first reconcile pass', async () => {
    expect(await boardType()).toBeNull();
    await reconcile.run();
    expect(await boardType()).toBe('scrum');
  });

  it('introspection failure skips the pass without crashing; the next pass retries', async () => {
    // Reset to unknown and point at a board the mock 404s.
    await db.db
      .update(schema.workspaces)
      .set({ jiraBoardType: null, jiraBoardId: 999, updatedAt: sql`now()` })
      .where(eq(schema.workspaces.id, workspaceId));

    // Pass skipped (no throw); board type stays unknown.
    await expect(reconcile.run()).resolves.toBeUndefined();
    expect(await boardType()).toBeNull();

    // Board becomes reachable → the next pass retries and succeeds.
    await db.db
      .update(schema.workspaces)
      .set({ jiraBoardId: 42, updatedAt: sql`now()` })
      .where(eq(schema.workspaces.id, workspaceId));
    await reconcile.run();
    expect(await boardType()).toBe('scrum');
  });
});

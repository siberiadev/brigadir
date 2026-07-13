import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { ReconcileService } from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';
const TRIGGER = 'Ready for Dev';

/**
 * T067 (US6): `scope_jql` filters triggers (FR-038; SC-011 filter half). With
 * `scope_jql = "labels = ai-pipeline"`, a ticket lacking the label never
 * triggers even while sitting in a trigger status; an otherwise-identical
 * labeled ticket does.
 */
describe('scope_jql global filter (T067)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let agentId: string;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: BASE,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
        settings: { scope_jql: 'labels = ai-pipeline' },
      })
      .returning({ id: schema.workspaces.id });
    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', concurrencyLimit: 2 })
      .returning({ id: schema.executors.id });
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId: ws.id,
        executorId: exec.id,
        name: 'impl',
        instruction: 'do it',
        triggerStatus: TRIGGER,
        statusSuccess: 'Code Review',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'success' },
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    agentId = agent.id;

    // Both sit in the trigger status; only BRIG-2 carries the required label.
    mock.seedIssue('BRIG-1', { status: TRIGGER });
    mock.seedIssue('BRIG-2', { status: TRIGGER, labels: ['ai-pipeline'] });

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    reconcile = worker.get(ReconcileService, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  it('only the labeled ticket triggers; the unlabeled one never does', async () => {
    await reconcile.run();

    const runs = await db.db
      .select({ ticketId: schema.runs.ticketId })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentId));
    expect(runs).toHaveLength(1);

    const [labeled] = await db.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.jiraKey, 'BRIG-2'));
    expect(runs[0].ticketId).toBe(labeled.id);

    // The unlabeled ticket was filtered out of scope entirely — no ticket row even created.
    const unlabeled = await db.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.jiraKey, 'BRIG-1'));
    expect(unlabeled).toHaveLength(0);
  });
});

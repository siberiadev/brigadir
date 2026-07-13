import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import {
  ReconcileService,
  PollerService,
  WatchdogService,
  DriftRepairService,
} from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';
const TRIGGER = 'Ready for Dev';
const NOOP_SCHEDULER = { onApplicationBootstrap: async () => {} };

async function seedWorkspaceAndAgent(db: DbHarness): Promise<{ workspaceId: string; agentId: string }> {
  const [ws] = await db.db
    .insert(schema.workspaces)
    .values({
      name: 'ws',
      jiraSiteUrl: BASE,
      jiraProjectKey: 'BRIG',
      jiraBoardId: 42,
      jiraBoardType: 'kanban',
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    })
    .returning({ id: schema.workspaces.id });
  const [exec] = await db.db
    .insert(schema.executors)
    .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 2 })
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
  return { workspaceId: ws.id, agentId: agent.id };
}

/**
 * T064 (US2): a one-hour outage with N missed status changes → exactly N runs
 * on the first reconcile pass; an immediate second pass → 0 additional
 * (SC-002 / FR-011–FR-014, FR-017). Nothing lost, nothing duplicated.
 */
describe('reconcile catch-up: no lost events, no duplicates (T064)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let agentId: string;

  const N = 4;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    ({ agentId } = await seedWorkspaceAndAgent(db));

    // N tickets slipped into the trigger status during a ~1h outage.
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 1; i <= N; i++) {
      mock.seedIssue(`BRIG-${i}`, {
        status: TRIGGER,
        updated: new Date(base + i * 60_000).toISOString(),
      });
    }

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue(NOOP_SCHEDULER)
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

  async function totalRuns(): Promise<number> {
    const rows = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentId));
    return rows.length;
  }

  it('one pass triggers exactly N; the next pass triggers 0 (SC-002)', async () => {
    await reconcile.run();
    expect(await totalRuns()).toBe(N);

    await reconcile.run();
    expect(await totalRuns()).toBe(N);
  });
});

/**
 * T063 (US2): the four reconcile steps are independently try/caught — a step
 * forced to throw must not prevent the later steps from running.
 */
describe('reconcile orchestration: one failing step does not starve the rest (T063)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let module: TestingModule;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    await seedWorkspaceAndAgent(db);
  }, 240_000);

  afterAll(async () => {
    await module?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  it('poll throws → dependency re-eval, watchdog and drift repair still run', async () => {
    const ran = { watchdog: false, drift: false };
    module = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue(NOOP_SCHEDULER)
      .overrideProvider(PollerService)
      .useValue({
        pollAndDiff: async () => {
          throw new Error('forced poll failure');
        },
      })
      .overrideProvider(WatchdogService)
      .useValue({
        sweep: async () => {
          ran.watchdog = true;
        },
      })
      .overrideProvider(DriftRepairService)
      .useValue({
        repair: async () => {
          ran.drift = true;
        },
      })
      .compile();
    await module.init();

    const reconcile = module.get(ReconcileService, { strict: false });
    await reconcile.run();

    // The poll step threw, but the orchestrator kept going.
    expect(ran.watchdog).toBe(true);
    expect(ran.drift).toBe(true);
  });
});

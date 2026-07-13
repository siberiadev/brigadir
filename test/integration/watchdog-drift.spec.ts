import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { WatchdogService, DriftRepairService, type WorkspaceContext } from '@brigadir/ingest';
import type { AgentReport } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';
const TRIGGER = 'Ready for Dev';

const SUCCESS_REPORT: AgentReport = {
  schema_version: 1,
  outcome: 'success',
  summary: 'done',
  checks: [{ name: 'tests', status: 'pass' }],
};

/**
 * T068 (US4): watchdog + drift repair (FR-015, FR-016; SC-006, SC-007).
 *  - a run `running` past timeout + grace → timed_out + failure-outcome Jira
 *    treatment;
 *  - a run whose result is persisted but whose Jira write was interrupted (no
 *    `jira_action` marker) → the transition + comment are re-applied, DB and
 *    Jira agree, and no duplicate active run is created.
 */
describe('watchdog + drift repair (T068)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let watchdog: WatchdogService;
  let drift: DriftRepairService;
  let ws: WorkspaceContext;
  let workspaceId: string;
  let agentId: string;
  let counter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const [w] = await db.db
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
    workspaceId = w.id;
    ws = { id: workspaceId, projectKey: 'BRIG', boardId: 42, boardType: 'kanban' };

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 2 })
      .returning({ id: schema.executors.id });
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId: exec.id,
        name: 'impl',
        instruction: 'do it',
        triggerStatus: TRIGGER,
        statusRunning: null,
        statusSuccess: 'Code Review',
        statusFailure: 'Blocked',
        timeoutMinutes: 1,
        behavior: {},
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    agentId = agent.id;

    // No worker consumption needed (we insert runs directly); just neuter the scheduler.
    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    watchdog = worker.get(WatchdogService, { strict: false });
    drift = worker.get(DriftRepairService, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(() => mock.reset());

  async function seedTicket(status: string): Promise<{ ticketId: string; key: string }> {
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status });
    const [t] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: status })
      .returning({ id: schema.tickets.id });
    return { ticketId: t.id, key };
  }

  it('watchdog: a run running past timeout+grace → timed_out + failure treatment (SC-006)', async () => {
    const { ticketId, key } = await seedTicket(TRIGGER);
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId,
        agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
        startedAt: sql`now() - interval '30 minutes'`, // well past timeout(1m)+grace(5m)
      })
      .returning({ id: schema.runs.id });

    await watchdog.sweep(ws);

    const [after] = await db.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    expect(after.status).toBe('timed_out');
    expect(mock.transitionsFor(key)).toEqual(['Blocked']); // status_failure
    expect(mock.commentsFor(key)).toHaveLength(1);

    // jira_action marker recorded (so drift repair won't re-apply).
    const marker = await db.db
      .select({ id: schema.runEvents.id })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, run.id), eq(schema.runEvents.type, 'jira_action')));
    expect(marker).toHaveLength(1);
  });

  it('drift repair: a persisted result with no jira_action marker → re-applied, no duplicate run (SC-007)', async () => {
    const { ticketId, key } = await seedTicket(TRIGGER);
    // A terminal run persisted, but the Jira write was interrupted (no marker).
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId,
        agentId,
        executorType: 'mock',
        status: 'succeeded',
        outcome: 'success',
        report: SUCCESS_REPORT,
        attempt: 1,
        startedAt: sql`now() - interval '2 minutes'`,
        finishedAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: schema.runs.id });

    await drift.repair(ws);

    // Pending transition + comment applied; run status unchanged.
    expect(mock.transitionsFor(key)).toEqual(['Code Review']); // status_success
    expect(mock.commentsFor(key)).toHaveLength(1);
    const [after] = await db.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    expect(after.status).toBe('succeeded');

    // Idempotent: a second repair pass re-applies nothing (marker present now).
    await drift.repair(ws);
    expect(mock.transitionsFor(key)).toEqual(['Code Review']);
    expect(mock.commentsFor(key)).toHaveLength(1);

    // No duplicate run for (ticket, agent).
    const runs = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, ticketId), eq(schema.runs.agentId, agentId)));
    expect(runs).toHaveLength(1);
  });
});

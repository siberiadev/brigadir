import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import type { AgentReport } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';

/**
 * T022 (US2, SC-003): the deterministic guards that keep the loop safe. Budget
 * exhaustion, invalid/raced routing targets, and orchestrator failure all land
 * in the Human Queue as NON-blocking tasks, and an orchestrator "needs human"
 * produces no ticket transition (FR-005/009/010/011). These guard paths never
 * enqueue, so each state is seeded and `pipeline.onRunFinished` is invoked
 * directly.
 */
describe('orchestrator routing guards → human fallbacks (T022)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let pipeline: PipelineService;
  let workspaceId: string;
  let executorId: string;
  let developerId: string;
  let fixerId: string;
  let orchestratorId: string;
  let counter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;

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
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 4 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    const [dev] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'Developer',
        instruction: 'impl',
        statusRunning: 'In Progress',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'failure' },
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    developerId = dev.id;

    const [fixer] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'Fixer',
        instruction: 'fix',
        statusRunning: 'In Progress',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'success' },
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    fixerId = fixer.id;

    const [orch] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'brigadir',
        instruction: 'orchestrate',
        isOrchestrator: true,
        statusRunning: null,
        statusSuccess: 'Blocked',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'routed' },
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    orchestratorId = orch.id;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    pipeline = worker.get(PipelineService, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  async function newTicket(status = 'Blocked'): Promise<{ id: string; key: string }> {
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });
    return { id: ticket.id, key };
  }

  async function insertRun(opts: {
    agentId: string;
    ticketId: string;
    status: string;
    report?: AgentReport | null;
    source: string;
    extraTrigger?: Record<string, unknown>;
  }): Promise<string> {
    const [row] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: opts.ticketId,
        agentId: opts.agentId,
        executorType: 'mock',
        status: opts.status,
        attempt: 1,
        report: opts.report ?? null,
        triggerEvent: { source: opts.source, ...(opts.extraTrigger ?? {}) },
      })
      .returning({ id: schema.runs.id });
    return row.id;
  }

  async function openTasksFor(ticketId: string) {
    return db.db
      .select({ id: schema.humanTasks.id, blocking: schema.humanTasks.blocking, details: schema.humanTasks.details })
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.ticketId, ticketId), eq(schema.humanTasks.status, 'open')));
  }

  async function marker(runId: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await db.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'jira_action')))
      .limit(1);
    return row?.payload as Record<string, unknown> | undefined;
  }

  async function triageRunsFor(ticketId: string): Promise<number> {
    const rows = await db.db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.ticketId, ticketId),
          eq(schema.runs.agentId, orchestratorId),
          sql`${schema.runs.triggerEvent} ->> 'source' = 'triage'`,
        ),
      );
    return rows[0]?.c ?? 0;
  }

  const failReport: AgentReport = {
    schema_version: 1,
    outcome: 'failure',
    summary: 'failed',
    checks: [{ name: 'tests', status: 'fail', reason: 'boom' }],
  };
  const routedReport = (target: string): AgentReport => ({
    schema_version: 1,
    outcome: 'routed',
    summary: `route to ${target}`,
    checks: [],
    routing: { target_agent: target, task: 'fix the thing' },
  });

  it('AC US2-1: budget exhausted → non-blocking human task, no triage', async () => {
    const ticket = await newTicket();
    // Exhaust the default budget of 2 with two prior rework runs on the ticket.
    await insertRun({ agentId: fixerId, ticketId: ticket.id, status: 'failed', source: 'rework' });
    await insertRun({ agentId: fixerId, ticketId: ticket.id, status: 'failed', source: 'rework' });
    const failed = await insertRun({
      agentId: developerId,
      ticketId: ticket.id,
      status: 'failed',
      report: failReport,
      source: 'poll',
    });

    await pipeline.onRunFinished(failed);

    expect(await triageRunsFor(ticket.id)).toBe(0);
    const tasks = await openTasksFor(ticket.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].blocking).toBe(false);
    expect((await marker(failed))?.triage_decision).toBe('cycle_limit');
  });

  it('AC US2-2: routed to an invalid target → override to a human task with the reason', async () => {
    const ticket = await newTicket();
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'succeeded',
      report: routedReport('Ghost'), // no such agent
      source: 'triage',
    });

    await pipeline.onRunFinished(orchRun);

    const tasks = await openTasksFor(ticket.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].blocking).toBe(false);
    expect(String(tasks[0].details)).toMatch(/Ghost|not a valid/i);
    // No rework run was enqueued.
    const reworkRuns = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, ticket.id), sql`${schema.runs.triggerEvent} ->> 'source' = 'rework'`));
    expect(reworkRuns).toHaveLength(0);
    expect((await marker(orchRun))?.orchestrator_decision).toBe('override_invalid_target');
  });

  it('AC US2-3: valid target but budget raced to exhaustion → override to a human task', async () => {
    const ticket = await newTicket();
    await insertRun({ agentId: fixerId, ticketId: ticket.id, status: 'failed', source: 'rework' });
    await insertRun({ agentId: fixerId, ticketId: ticket.id, status: 'failed', source: 'rework' });
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'succeeded',
      report: routedReport('Fixer'), // valid, but budget exhausted
      source: 'triage',
    });

    await pipeline.onRunFinished(orchRun);

    const tasks = await openTasksFor(ticket.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].blocking).toBe(false);
    expect(String(tasks[0].details)).toMatch(/budget exhausted/i);
    expect((await marker(orchRun))?.orchestrator_decision).toBe('override_budget');
  });

  it('AC US2-4: orchestrator run failed → human task, no re-triage', async () => {
    const ticket = await newTicket();
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'failed',
      report: null,
      source: 'triage',
    });

    await pipeline.onRunFinished(orchRun);

    const tasks = await openTasksFor(ticket.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].blocking).toBe(false);
    expect(String(tasks[0].details)).toMatch(/orchestrator/i);
    // The triager is never triaged: no second triage run beyond the seeded one.
    expect(await triageRunsFor(ticket.id)).toBe(1);
    expect((await marker(orchRun))?.orchestrator_decision).toBe('orchestrator_failed');
  });

  it('FR-011: orchestrator "needs human" → decision recorded, no ticket transition', async () => {
    const ticket = await newTicket();
    const needsHuman: AgentReport = {
      schema_version: 1,
      outcome: 'needs_human',
      summary: 'ambiguous',
      checks: [],
      human_task: { kind: 'question', title: 'which way?' },
    };
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'awaiting_human',
      report: needsHuman,
      source: 'triage',
    });

    await pipeline.onRunFinished(orchRun);

    expect((await marker(orchRun))?.orchestrator_decision).toBe('needs_human');
    // No ticket transition happened (the ticket already sits in its failure status).
    expect(mock.transitionsFor(ticket.key)).toEqual([]);
  });
});

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
        key: 'developer',
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
        key: 'fixer',
        instruction: 'fix',
        statusRunning: 'In Progress',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'success' },
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    fixerId = fixer.id;

    // SXF-1174 seed: a valid worker whose running status is NOT in the mock
    // board's category catalog — `transitionTo` deterministically throws
    // NoTransitionPath for it (the mock offers transitions only to known
    // catalog statuses).
    await db.db.insert(schema.agents).values({
      workspaceId,
      executorId,
      name: 'QA',
      key: 'qa',
      instruction: 'verify',
      statusRunning: 'QA Running',
      statusSuccess: 'Done',
      statusFailure: 'Blocked',
      behavior: { mock_scenario: 'success' },
      maxAttempts: 1,
    });

    const [orch] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'brigadir',
        key: 'brigadir',
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

  async function reworkRunsFor(ticketId: string): Promise<Array<{ id: string; status: string }>> {
    return db.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.ticketId, ticketId),
          sql`${schema.runs.triggerEvent} ->> 'source' = 'rework'`,
        ),
      );
  }

  async function errorEventsFor(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'error')));
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
      await new Promise((r) => setTimeout(r, 250));
    }
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
      report: routedReport('fixer'), // valid key, but budget exhausted
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

  // --- SXF-1174 (remediation Problems 1+2): replay idempotency + diagnostics ---

  it('SXF-1174a: NoTransitionPath on routing → nothing enqueued, diagnostic persisted, replay stays at zero', async () => {
    const ticket = await newTicket();
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'succeeded',
      report: routedReport('qa'), // qa's statusRunning is unreachable on the board
      source: 'triage',
    });

    // Resolves (board fault is swallowed for self-heal), does not reject.
    await pipeline.onRunFinished(orchRun);

    // Jira precedes the enqueue: the failed transition left NOTHING enqueued.
    expect(await reworkRunsFor(ticket.id)).toHaveLength(0);
    expect(mock.transitionsFor(ticket.key)).toEqual([]);
    // No marker → the next reconcile pass retries (self-healing after a board fix).
    expect(await marker(orchRun)).toBeUndefined();
    // Problem 2: the fault is diagnosable from persisted run events.
    const errors = await errorEventsFor(orchRun);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ stage: 'jira_transition' });
    expect(String(errors[0].error)).toMatch(/no Jira transition/i);

    // Replay (what drift repair does every pass): still nothing enqueued.
    await pipeline.onRunFinished(orchRun);
    expect(await reworkRunsFor(ticket.id)).toHaveLength(0);
    expect(await marker(orchRun)).toBeUndefined();
    expect(await errorEventsFor(orchRun)).toHaveLength(2); // one diagnostic per attempt
  });

  it('SXF-1174b: replay with a TERMINAL rework run for the decision mints no second run (b4d27e5e shape)', async () => {
    const ticket = await newTicket();
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'succeeded',
      report: routedReport('fixer'),
      source: 'triage',
    });
    // The incident state: a rework run for this decision already went terminal,
    // and the decision has no jira_action marker — drift repair replays it.
    await insertRun({
      agentId: fixerId,
      ticketId: ticket.id,
      status: 'cancelled',
      source: 'rework',
      extraTrigger: { deciding_run_id: orchRun },
    });

    await pipeline.onRunFinished(orchRun);

    // runs_one_active no longer guards (the run is terminal) — the
    // deciding_run_id dedup must: still exactly one rework run.
    expect(await reworkRunsFor(ticket.id)).toHaveLength(1);
    // Dedup hit skips the (already-done or stale) Jira writes entirely.
    expect(mock.transitionsFor(ticket.key)).toEqual([]);
    // The marker lands, so drift repair stops selecting this run.
    expect((await marker(orchRun))?.orchestrator_decision).toBe('routed');

    // Second replay: byte-identical outcome.
    await pipeline.onRunFinished(orchRun);
    expect(await reworkRunsFor(ticket.id)).toHaveLength(1);
    expect(mock.transitionsFor(ticket.key)).toEqual([]);
  });

  it('SXF-1174c: replay after successful routing is a full no-op (orchestrator-path marker guard)', async () => {
    const ticket = await newTicket();
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'succeeded',
      report: routedReport('fixer'),
      source: 'triage',
    });

    await pipeline.onRunFinished(orchRun);

    // Routing succeeded end-to-end: transition + comment + enqueued rework run.
    expect((await marker(orchRun))?.orchestrator_decision).toBe('routed');
    // Let the rework run finish (mock executor drives it to succeeded), and
    // wait for ITS jira_action marker too — persist-then-write means its own
    // Jira writes land after the status flip, and they must not race the
    // snapshot below.
    const reworkRun = await waitFor(async () => {
      const [run] = await reworkRunsFor(ticket.id);
      return run && run.status === 'succeeded' ? run : undefined;
    });
    await waitFor(async () => marker(reworkRun.id));

    const transitionsBefore = [...mock.transitionsFor(ticket.key)];
    const commentsBefore = mock.commentsFor(ticket.key).length;

    await pipeline.onRunFinished(orchRun);

    expect(await reworkRunsFor(ticket.id)).toHaveLength(1);
    expect(mock.transitionsFor(ticket.key)).toEqual(transitionsBefore);
    expect(mock.commentsFor(ticket.key).length).toBe(commentsBefore);
    expect((await marker(orchRun))?.orchestrator_decision).toBe('routed');
  });

  // --- SXF-1174 Problem 6: per-ticket serialization ---

  it('SXF-1174d (Problem 6): routed decision while another agent is active → override_active_run, no Jira writes, no rework run', async () => {
    const ticket = await newTicket();
    // The conflict: fixer is actively working the ticket.
    await insertRun({
      agentId: fixerId,
      ticketId: ticket.id,
      status: 'running',
      source: 'poll',
    });
    const orchRun = await insertRun({
      agentId: orchestratorId,
      ticketId: ticket.id,
      status: 'succeeded',
      report: routedReport('developer'),
      source: 'triage',
    });

    await pipeline.onRunFinished(orchRun);

    // Nothing routed, nothing written to Jira (guard sits before the Jira block).
    expect(await reworkRunsFor(ticket.id)).toHaveLength(0);
    expect(mock.transitionsFor(ticket.key)).toEqual([]);
    expect(mock.commentsFor(ticket.key)).toHaveLength(0);
    expect((await marker(orchRun))?.orchestrator_decision).toBe('override_active_run');
    const tasks = await openTasksFor(ticket.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].blocking).toBe(false);
    expect(String(tasks[0].details)).toMatch(/Fixer/);
    expect(String(tasks[0].details)).toMatch(/active run/);
    expect(String(tasks[0].details)).toContain('fix the thing'); // routing.task carried along

    // Replay: marker guard makes it a full no-op, still exactly one task.
    await pipeline.onRunFinished(orchRun);
    expect(await reworkRunsFor(ticket.id)).toHaveLength(0);
    expect(await openTasksFor(ticket.id)).toHaveLength(1);
  });

  it("SXF-1174e (Problem 6): triage trigger dedups against another agent's active run → triage_deduplicated", async () => {
    // Seeded OUTSIDE the failure status so the failure transition is a real
    // POST, not transitionTo's already-in-target no-op.
    const ticket = await newTicket('In Progress');
    await insertRun({
      agentId: fixerId,
      ticketId: ticket.id,
      status: 'running',
      source: 'poll',
    });
    const failedRun = await insertRun({
      agentId: developerId,
      ticketId: ticket.id,
      status: 'failed',
      report: failReport,
      source: 'poll',
    });

    await pipeline.onRunFinished(failedRun);

    // The worker failure treatment itself is unchanged…
    expect(mock.transitionsFor(ticket.key)).toEqual(['Blocked']);
    expect(mock.commentsFor(ticket.key)).toHaveLength(1);
    // …but no triage run was minted (fixer holds the per-ticket slot), and the
    // marker records that honestly.
    expect(await triageRunsFor(ticket.id)).toBe(0);
    expect((await marker(failedRun))?.triage_decision).toBe('triage_deduplicated');
  });
});

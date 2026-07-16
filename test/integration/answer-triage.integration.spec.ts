import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { ResumeService } from '@brigadir/human-tasks';
import { MockExecutor, type RunContext } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';

/**
 * Answer-triage delta (FR-025/026, AC US3-5/6): resolving a blocking human task
 * with the orchestrator as the resume target creates an `answer-triage` run
 * whose prompt carries the Q&A + failure context + roster; its routed decision
 * creates the rework run even when the rework budget is exhausted (the human
 * answer grants one extra cycle), and the rework trigger carries the human
 * task id. A parked ORCHESTRATOR run resumed with no explicit target also
 * re-triages (effective-agent rule).
 */
describe('answer-triage resume (delta on 010)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let resume: ResumeService;
  let runSpy: ReturnType<typeof vi.spyOn>;
  let workspaceId: string;
  let executorId: string;
  let workerAgentId: string;
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
        // rework budget deliberately at the default (2) — exhausted by seeding
        // two rework-sourced runs per ticket in the budget test below.
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 4 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    const [workerAgent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'Developer',
        key: 'developer',
        description: 'Implements features',
        instruction: 'You are Developer.',
        statusRunning: 'In Progress',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'success' },
        enabled: true,
        maxAttempts: 3,
      })
      .returning({ id: schema.agents.id });
    workerAgentId = workerAgent.id;

    // The orchestrator, mirroring orchestrator-seed.ts: statusRunning NULL,
    // inert success/failure. The mock `routed` scenario reads the route target
    // from the trigger event, threaded from behavior.route_target.
    const [brig] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'brigadir',
        key: 'brigadir',
        instruction: 'You are brigadir.',
        isOrchestrator: true,
        triggerStatus: null,
        statusRunning: null,
        statusSuccess: '—',
        statusFailure: '—',
        behavior: { mock_scenario: 'routed', route_target: 'developer' },
        enabled: true,
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    orchestratorId = brig.id;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    resume = worker.get(ResumeService, { strict: false });

    const mockExecutor = worker.get(MockExecutor, { strict: false });
    runSpy = vi.spyOn(mockExecutor, 'run');
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function ticketRuns(ticketId: string) {
    return db.db
      .select({
        id: schema.runs.id,
        agentId: schema.runs.agentId,
        status: schema.runs.status,
        triggerEvent: schema.runs.triggerEvent,
      })
      .from(schema.runs)
      .where(eq(schema.runs.ticketId, ticketId));
  }

  /**
   * Park a WORKER run (with a persisted failure report) on a fresh ticket +
   * open blocking human task. Optionally pre-exhaust the rework budget.
   */
  async function parkWorkerRun(opts: { exhaustBudget?: boolean } = {}) {
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status: 'Blocked' });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });

    if (opts.exhaustBudget) {
      // Two prior rework-sourced runs — the default budget (2) is exhausted.
      for (let i = 0; i < 2; i++) {
        await db.db.insert(schema.runs).values({
          workspaceId,
          ticketId: ticket.id,
          agentId: workerAgentId,
          executorType: 'mock',
          status: 'failed',
          attempt: 1,
          finishedAt: new Date(),
          triggerEvent: { source: 'rework', task: `earlier rework ${i + 1}` },
        });
      }
    }

    const [parked] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: ticket.id,
        agentId: workerAgentId,
        executorType: 'mock',
        status: 'awaiting_human',
        attempt: 1,
        report: {
          schema_version: 1,
          outcome: 'needs_human',
          summary: 'Spec example contradicts the FR-004 formula.',
          checks: [{ name: 'scenario_4', status: 'fail', reason: 'legal_name never matches' }],
          human_task: { title: 'Formula or example?', details: 'Which one wins?' },
        },
        triggerEvent: { source: 'poll' },
      })
      .returning({ id: schema.runs.id });

    const [task] = await db.db
      .insert(schema.humanTasks)
      .values({
        workspaceId,
        ticketId: ticket.id,
        runId: parked.id,
        kind: 'question',
        title: 'Formula or example?',
        details: 'Which one wins?',
        blocking: true,
        status: 'open',
      })
      .returning({ id: schema.humanTasks.id });
    return { taskId: task.id, parkedRunId: parked.id, key, ticketId: ticket.id };
  }

  it('resolving to the orchestrator creates an answer-triage run whose prompt carries Q&A + failure + roster', async () => {
    const { taskId, parkedRunId, ticketId } = await parkWorkerRun();

    const result = await resume.resolve(taskId, {
      action: 'resume',
      answer: 'Option 1 — the formula is authoritative.',
      target_agent_id: orchestratorId,
    });
    expect(result.outcome).toBe('resumed');
    const triageRunId = (result as { newRunId: string }).newRunId;

    const runs = await ticketRuns(ticketId);
    const triageRun = runs.find((r) => r.id === triageRunId)!;
    expect(triageRun.agentId).toBe(orchestratorId);
    const trigger = triageRun.triggerEvent as Record<string, unknown>;
    expect(trigger.source).toBe('answer-triage');
    expect(trigger.failing_run_id).toBe(parkedRunId);
    expect(trigger.human_task_id).toBe(taskId);

    // The routed decision produces a rework run for Developer.
    await waitFor(async () =>
      (await ticketRuns(ticketId)).some(
        (r) => (r.triggerEvent as Record<string, unknown>)?.source === 'rework',
      ),
    );

    const ctx = runSpy.mock.calls.map((c) => c[0] as RunContext).find((c) => c.runId === triageRunId);
    expect(ctx).toBeDefined();
    expect(ctx!.instruction).toContain('## Handoff — triage (human answered)');
    expect(ctx!.instruction).toContain('Question: Formula or example?');
    expect(ctx!.instruction).toContain('Answer: Option 1 — the formula is authoritative.');
    expect(ctx!.instruction).toContain('Failing run: Spec example contradicts the FR-004 formula.');
    // feature 014: roster renders "- <key> — <name> (<role>): <description>".
    expect(ctx!.instruction).toContain('- developer — Developer: Implements features');
    expect(ctx!.instruction).toContain('Decision protocol:');
  }, 120_000);

  it('grants one rework cycle past an exhausted budget and forwards human_task_id; ticket moves to the target status', async () => {
    const { taskId, ticketId, key } = await parkWorkerRun({ exhaustBudget: true });

    const result = await resume.resolve(taskId, {
      action: 'resume',
      answer: 'Proceed as discussed.',
      target_agent_id: orchestratorId,
    });
    expect(result.outcome).toBe('resumed');

    // Despite cycleCount=2 of max 2, the routed decision still creates a rework run.
    await waitFor(async () =>
      (await ticketRuns(ticketId)).some(
        (r) =>
          (r.triggerEvent as Record<string, unknown>)?.source === 'rework' &&
          (r.triggerEvent as Record<string, unknown>)?.human_task_id === taskId,
      ),
    );
    const rework = (await ticketRuns(ticketId)).find(
      (r) => (r.triggerEvent as Record<string, unknown>)?.human_task_id === taskId,
    )!;
    expect(rework.agentId).toBe(workerAgentId);

    // The ticket transitioned to the rework target's running status (the
    // answer-triage run itself never transitions — orchestrator statusRunning is NULL).
    await waitFor(() => mock.transitionsFor(key).includes('In Progress'));
  }, 120_000);

  it('a parked ORCHESTRATOR run resumed with no explicit target still re-triages (effective-agent rule)', async () => {
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status: 'Blocked' });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });

    // The original failed worker run the parked orchestrator's trigger references.
    const [failedWorker] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: ticket.id,
        agentId: workerAgentId,
        executorType: 'mock',
        status: 'failed',
        attempt: 1,
        finishedAt: new Date(),
        report: {
          schema_version: 1,
          outcome: 'failure',
          summary: 'Original worker failure.',
          checks: [],
        },
        triggerEvent: { source: 'poll' },
      })
      .returning({ id: schema.runs.id });

    // Brigadir's own parked needs_human run (from an earlier automatic triage).
    const [parkedBrig] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: ticket.id,
        agentId: orchestratorId,
        executorType: 'mock',
        status: 'awaiting_human',
        attempt: 1,
        triggerEvent: { source: 'triage', failing_run_id: failedWorker.id },
      })
      .returning({ id: schema.runs.id });

    const [task] = await db.db
      .insert(schema.humanTasks)
      .values({
        workspaceId,
        ticketId: ticket.id,
        runId: parkedBrig.id,
        kind: 'question',
        title: 'Which worker should take this?',
        details: null,
        blocking: true,
        status: 'open',
      })
      .returning({ id: schema.humanTasks.id });

    // No target_agent_id — the web guard suppresses it when it equals the
    // original agent. The EFFECTIVE agent is the orchestrator ⇒ answer-triage.
    const result = await resume.resolve(task.id, { action: 'resume', answer: 'Developer.' });
    expect(result.outcome).toBe('resumed');
    const newRunId = (result as { newRunId: string }).newRunId;

    const runs = await ticketRuns(ticket.id);
    const newRun = runs.find((r) => r.id === newRunId)!;
    expect(newRun.agentId).toBe(orchestratorId);
    const trigger = newRun.triggerEvent as Record<string, unknown>;
    expect(trigger.source).toBe('answer-triage');
    // The failing-run reference is FORWARDED from the parked orchestrator's
    // trigger — the original worker failure, not the parked triage run.
    expect(trigger.failing_run_id).toBe(failedWorker.id);
  }, 120_000);
});

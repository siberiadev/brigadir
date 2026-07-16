import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { slugifyAgentKey } from '@brigadir/contracts';
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
 * T029 (US3, SC-004): the Human Queue resume picker. Resolving a blocking task
 * resumes the original agent by default (AC US3-1); choosing a different enabled
 * agent creates the new run for it with the attempt restarted and the ticket
 * moved to the chosen agent's running status (AC US3-2); an invalid target id is
 * rejected and nothing changes (AC US3-3). The resumed prompt carries the
 * question + operator answer via the handoff section (FR-016).
 */
describe('human-resume agent picker (T029)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let resume: ResumeService;
  let runSpy: ReturnType<typeof vi.spyOn>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let executorId: string;
  let originalId: string;
  let otherId: string;
  let disabledId: string;
  let foreignAgentId: string;
  let counter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const mkWs = async (name: string) => {
      const [ws] = await db.db
        .insert(schema.workspaces)
        .values({
          name,
          jiraSiteUrl: BASE,
          jiraProjectKey: 'BRIG',
          jiraBoardId: 42,
          jiraBoardType: 'kanban',
          jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
        })
        .returning({ id: schema.workspaces.id });
      return ws.id;
    };
    workspaceId = await mkWs('ws');
    otherWorkspaceId = await mkWs('other-ws');

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 4 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    const mkAgent = async (
      wsId: string,
      name: string,
      opts: { enabled?: boolean; statusRunning?: string } = {},
    ) => {
      const [a] = await db.db
        .insert(schema.agents)
        .values({
          workspaceId: wsId,
          executorId,
          name,
          key: slugifyAgentKey(name),
          instruction: `You are ${name}.`,
          statusRunning: opts.statusRunning ?? 'In Progress',
          statusSuccess: 'Done',
          statusFailure: 'Blocked',
          behavior: { mock_scenario: 'success' },
          enabled: opts.enabled ?? true,
          maxAttempts: 3,
        })
        .returning({ id: schema.agents.id });
      return a.id;
    };
    originalId = await mkAgent(workspaceId, 'Original');
    otherId = await mkAgent(workspaceId, 'Other', { statusRunning: 'Code Review' });
    disabledId = await mkAgent(workspaceId, 'Disabled', { enabled: false });
    foreignAgentId = await mkAgent(otherWorkspaceId, 'Foreign');

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

  /** Park a run for `Original` on a fresh ticket + open blocking human task. */
  async function parkRun(): Promise<{ taskId: string; parkedRunId: string; key: string; ticketId: string }> {
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status: 'Blocked' });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });
    const [parked] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: ticket.id,
        agentId: originalId,
        executorType: 'mock',
        status: 'awaiting_human',
        attempt: 1,
      })
      .returning({ id: schema.runs.id });
    const [task] = await db.db
      .insert(schema.humanTasks)
      .values({
        workspaceId,
        ticketId: ticket.id,
        runId: parked.id,
        kind: 'question',
        title: 'Which staging DB URL?',
        details: 'The seed script needs a target database.',
        blocking: true,
        status: 'open',
      })
      .returning({ id: schema.humanTasks.id });
    return { taskId: task.id, parkedRunId: parked.id, key, ticketId: ticket.id };
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function runRow(runId: string) {
    const [row] = await db.db
      .select({ agentId: schema.runs.agentId, attempt: schema.runs.attempt, status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    return row;
  }

  it('AC US3-1: no target → resumes the original agent; prompt carries the Q + answer', async () => {
    const { taskId, key } = await parkRun();

    const result = await resume.resolve(taskId, {
      action: 'resume',
      answer: 'Use postgres://staging-db:5432/app',
    });
    expect(result.outcome).toBe('resumed');
    const newRunId = (result as { newRunId: string }).newRunId;

    const newRun = await runRow(newRunId);
    expect(newRun.agentId).toBe(originalId); // original agent
    expect(newRun.attempt).toBe(2); // attempt+1 for the same agent

    await waitFor(() => mock.commentsFor(key).length > 0); // run executed + finalized
    const ctx = runSpy.mock.calls.map((c) => c[0] as RunContext).find((c) => c.runId === newRunId);
    expect(ctx).toBeDefined();
    expect(ctx!.instruction).toContain('## Handoff — human answer');
    expect(ctx!.instruction).toContain('Which staging DB URL?');
    expect(ctx!.instruction).toContain('The seed script needs a target database.');
    expect(ctx!.instruction).toContain('Use postgres://staging-db:5432/app');
    expect(ctx!.instruction).toContain('You are Original.'); // stored instruction preserved
  });

  it('AC US3-2: a different enabled agent → new run for it, attempt=1, ticket at its running status', async () => {
    const { taskId, key } = await parkRun();

    const result = await resume.resolve(taskId, {
      action: 'resume',
      answer: 'go',
      target_agent_id: otherId,
    });
    expect(result.outcome).toBe('resumed');
    const newRunId = (result as { newRunId: string }).newRunId;

    const newRun = await runRow(newRunId);
    expect(newRun.agentId).toBe(otherId); // chosen agent
    expect(newRun.attempt).toBe(1); // restarted for the new agent

    await waitFor(() => mock.transitionsFor(key).includes('Code Review'));
    expect(mock.transitionsFor(key)).toContain('Code Review'); // Other's running status
  });

  it('AC US3-3: invalid target ids are rejected and nothing changes', async () => {
    for (const badId of [
      '00000000-0000-4000-8000-000000000000', // non-existent
      disabledId, // disabled
      foreignAgentId, // other workspace
    ]) {
      const { taskId, parkedRunId } = await parkRun();
      const result = await resume.resolve(taskId, {
        action: 'resume',
        answer: 'x',
        target_agent_id: badId,
      });
      expect(result.outcome).toBe('invalid_target');

      // Nothing changed: parked run still awaiting_human, task still open.
      const parked = await runRow(parkedRunId);
      expect(parked.status).toBe('awaiting_human');
      const [task] = await db.db
        .select({ status: schema.humanTasks.status })
        .from(schema.humanTasks)
        .where(eq(schema.humanTasks.id, taskId))
        .limit(1);
      expect(task.status).toBe('open');
    }
  });
});

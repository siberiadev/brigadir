import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import { MockExecutor, type RunContext } from '@brigadir/executors';
import type { ADFDoc, JiraIssue } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';

const issueAt = (key: string, status: string): JiraIssue => ({
  key,
  id: '10000',
  fields: {
    summary: key,
    status: { name: status, statusCategory: { key: 'indeterminate' } },
    updated: new Date().toISOString(),
    issuelinks: [],
  },
});

const panelTypeOf = (doc: ADFDoc): unknown =>
  (doc.content[0] as { attrs?: { panelType?: unknown } }).attrs?.panelType;

/**
 * T010 (US1, SC-001/002/007): the full fail → triage → route → rework → success
 * loop under the mock executor. Asserts exactly-one triage (SC-001), the rework
 * run's assembled prompt carries the task + failing context while the agent's
 * stored instruction is untouched (SC-002), Jira status/comments per step
 * (SC-007), and that a completion-replay of the failed run is a no-op (AC US1-5).
 */
describe('orchestrator routing loop: fail → triage → route → rework → success (T010)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let pipeline: PipelineService;
  let runSpy: ReturnType<typeof vi.spyOn>;
  let workspaceId: string;
  let executorId: string;
  let developerId: string;
  let fixerId: string;
  let orchestratorId: string;
  let ticketId: string;
  const KEY = 'BRIG-1';

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    // Register the Fixer's running status so its transition path exists.
    mock.setCategory('Fixing', 'indeterminate');

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

    // Developer fails; the orchestrator routes to Fixer; Fixer succeeds on rework.
    const [dev] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'Developer',
        description: 'Implements features',
        instruction: 'Implement the ticket.',
        triggerStatus: 'Ready for Dev',
        statusRunning: 'In Progress',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'failure' },
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    developerId = dev.id;

    const FIXER_INSTRUCTION = 'Fix the ticket.';
    const [fixer] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: 'Fixer',
        description: 'Fixes failing work',
        instruction: FIXER_INSTRUCTION,
        triggerStatus: 'Never', // not poll-triggered in this test
        statusRunning: 'Fixing',
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
        instruction: 'You are the orchestrator.',
        isOrchestrator: true,
        triggerStatus: null,
        triggerJql: null,
        statusRunning: null,
        statusSuccess: 'Blocked', // inert placeholders (FR-007)
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'routed', route_target: 'Fixer' },
        maxAttempts: 1,
      })
      .returning({ id: schema.agents.id });
    orchestratorId = orch.id;

    mock.seedIssue(KEY, { status: 'Ready for Dev' });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: KEY, jiraId: '10000', summary: KEY })
      .returning({ id: schema.tickets.id });
    ticketId = ticket.id;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    pipeline = worker.get(PipelineService, { strict: false });

    // Capture the RunContext each run receives so we can inspect assembled prompts.
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

  async function runsFor(agentId: string): Promise<Array<{ id: string; status: string; source: string }>> {
    const rows = await db.db
      .select({
        id: schema.runs.id,
        status: schema.runs.status,
        source: sql<string>`${schema.runs.triggerEvent} ->> 'source'`,
      })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentId));
    return rows;
  }

  it('drives the full loop and closes it at the success status', async () => {
    // Kick off: Developer is triggered by the status change.
    await pipeline.onStatusChanged({
      ticketId,
      issue: issueAt(KEY, 'Ready for Dev'),
      fromStatus: null,
      toStatus: 'Ready for Dev',
      source: 'scope_entry',
    });

    // Wait for the loop to close: the Fixer rework run succeeds.
    await waitFor(async () => {
      const fixerRuns = await runsFor(fixerId);
      return fixerRuns.some((r) => r.status === 'succeeded' && r.source === 'rework');
    });
    // Let the final Jira writes land.
    await waitFor(() => mock.transitionsFor(KEY).includes('Done'));

    // --- SC-001: exactly one triage run for the orchestrator ---
    const orchRuns = await runsFor(orchestratorId);
    const triageRuns = orchRuns.filter((r) => r.source === 'triage');
    expect(triageRuns).toHaveLength(1);
    expect(triageRuns[0].status).toBe('succeeded');

    // --- the Developer failed, a rework run exists for Fixer ---
    const devRuns = await runsFor(developerId);
    expect(devRuns.some((r) => r.status === 'failed')).toBe(true);
    const fixerRuns = await runsFor(fixerId);
    const reworkRun = fixerRuns.find((r) => r.source === 'rework');
    expect(reworkRun).toBeDefined();
    expect(reworkRun!.status).toBe('succeeded');

    // --- SC-007: Jira transitions + comments per step ---
    const transitions = mock.transitionsFor(KEY);
    expect(transitions).toContain('In Progress'); // Developer running
    expect(transitions).toContain('Blocked'); // Developer failure
    expect(transitions).toContain('Fixing'); // routed → Fixer running
    expect(transitions).toContain('Done'); // Fixer success
    // Failure comes before the route, which comes before success.
    expect(transitions.indexOf('Blocked')).toBeLessThan(transitions.indexOf('Fixing'));
    expect(transitions.lastIndexOf('Fixing')).toBeLessThan(transitions.indexOf('Done'));

    const comments = mock.commentsFor(KEY);
    const panels = comments.map(panelTypeOf);
    expect(panels).toContain('error'); // Developer failure comment
    expect(panels).toContain('info'); // routing comment + success comment
    // The routing comment names the target + task.
    const routingComment = JSON.stringify(comments);
    expect(routingComment).toContain('Fixer');

    // --- SC-002: the rework run's assembled prompt carries task + failing context,
    //     while Fixer's stored instruction is byte-for-byte unchanged ---
    const reworkCtx = runSpy.mock.calls
      .map((c) => c[0] as RunContext)
      .find((ctx) => ctx.runId === reworkRun!.id);
    expect(reworkCtx).toBeDefined();
    expect(reworkCtx!.instruction).toContain('## Handoff — rework (fix of existing work)');
    expect(reworkCtx!.instruction).toContain('Task from the orchestrator:');
    expect(reworkCtx!.instruction).toContain('Original failure:');
    expect(reworkCtx!.instruction).toContain('Fix the ticket.'); // the stored instruction still present

    const [fixerRow] = await db.db
      .select({ instruction: schema.agents.instruction })
      .from(schema.agents)
      .where(eq(schema.agents.id, fixerId))
      .limit(1);
    expect(fixerRow.instruction).toBe('Fix the ticket.'); // unchanged (SC-002)

    // The triage run's prompt carried the roster + protocol.
    const triageCtx = runSpy.mock.calls
      .map((c) => c[0] as RunContext)
      .find((ctx) => ctx.runId === triageRuns[0].id);
    expect(triageCtx).toBeDefined();
    expect(triageCtx!.instruction).toContain('## Handoff — triage');
    expect(triageCtx!.instruction).toContain('Available worker agents');
    expect(triageCtx!.instruction).toContain('Fixer: Fixes failing work');
    expect(triageCtx!.instruction).toContain('Decision protocol:');
  });

  it('replaying completion of the failed run is a no-op (SC-001, AC US1-5)', async () => {
    const devRuns = await runsFor(developerId);
    const failedRun = devRuns.find((r) => r.status === 'failed');
    expect(failedRun).toBeDefined();

    const triageBefore = (await runsFor(orchestratorId)).filter((r) => r.source === 'triage').length;
    await pipeline.onRunFinished(failedRun!.id); // drift-repair replay
    const triageAfter = (await runsFor(orchestratorId)).filter((r) => r.source === 'triage').length;

    expect(triageAfter).toBe(triageBefore);
    expect(triageAfter).toBe(1);
  });
});

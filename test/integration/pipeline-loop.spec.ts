import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import type { ADFDoc, JiraIssue, MockScenario } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

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
 * T056 (US1, closes F2): a status change drives the full loop on mock Jira —
 * enqueue → mock run → terminal transition + ADF checklist comment — for
 * success, failure and needs_human; the optional running-status transition
 * fires at job start; and a NoTransitionPath board config records the run as
 * failed with the diagnostic (FR-018–FR-024; SC-001, SC-005).
 */
describe('pipeline loop: status change → run → Jira transition + comment (T056)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let pipeline: PipelineService;
  let workspaceId: string;
  let executorId: string;
  let counter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    // Seed the workspace + executor BEFORE boot so the lazy Jira client resolves
    // real credentials pointing at the mock, and board type is already known.
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
      .values({ workspaceId, type: 'mock', name: 'mock-exec', concurrencyLimit: 2 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    // Neuter the periodic reconcile scheduler: these tests drive the pipeline
    // explicitly, so a background poll must not cross-trigger agents.
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

  async function fireStatusChange(opts: {
    name: string;
    triggerStatus: string;
    statusSuccess: string;
    statusFailure: string;
    statusRunning?: string;
    scenario: MockScenario;
  }): Promise<{ key: string; ticketId: string; agentId: string }> {
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status: opts.triggerStatus });
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name: opts.name,
        instruction: 'do it',
        triggerStatus: opts.triggerStatus,
        statusRunning: opts.statusRunning ?? null,
        statusSuccess: opts.statusSuccess,
        statusFailure: opts.statusFailure,
        behavior: { mock_scenario: opts.scenario },
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });

    await pipeline.onStatusChanged({
      ticketId: ticket.id,
      issue: issueAt(key, opts.triggerStatus),
      fromStatus: null,
      toStatus: opts.triggerStatus,
      source: 'scope_entry',
    });
    return { key, ticketId: ticket.id, agentId: agent.id };
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function runStatus(agentId: string): Promise<string> {
    const [row] = await db.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentId))
      .limit(1);
    return row?.status ?? '(none)';
  }

  it('success → status_running then status_success + info-panel comment', async () => {
    const { key, agentId } = await fireStatusChange({
      name: 'impl-success',
      triggerStatus: 'Ready for Dev',
      statusRunning: 'In Progress',
      statusSuccess: 'Code Review',
      statusFailure: 'Blocked',
      scenario: 'success',
    });

    // Wait for the comment (written after the transition) so both writes have landed.
    await waitFor(() => mock.commentsFor(key).length > 0);
    expect(await runStatus(agentId)).toBe('succeeded');
    expect(mock.transitionsFor(key)).toEqual(['In Progress', 'Code Review']);
    const comments = mock.commentsFor(key);
    expect(comments).toHaveLength(1);
    expect(panelTypeOf(comments[0])).toBe('info');
  });

  it('failure → status_failure + error-panel comment', async () => {
    const { key, agentId } = await fireStatusChange({
      name: 'impl-failure',
      triggerStatus: 'Backlog',
      statusSuccess: 'Code Review',
      statusFailure: 'Blocked',
      scenario: 'failure',
    });

    await waitFor(() => mock.commentsFor(key).length > 0);
    expect(await runStatus(agentId)).toBe('failed');
    expect(mock.transitionsFor(key)).toEqual(['Blocked']);
    const comments = mock.commentsFor(key);
    expect(comments).toHaveLength(1);
    expect(panelTypeOf(comments[0])).toBe('error');
  });

  it('needs_human → status_failure + warning-panel comment + exactly one open human_task', async () => {
    const { key, agentId, ticketId } = await fireStatusChange({
      name: 'impl-needs-human',
      triggerStatus: 'Code Review',
      statusSuccess: 'Done',
      statusFailure: 'Blocked',
      scenario: 'needs_human',
    });

    await waitFor(() => mock.commentsFor(key).length > 0);
    expect(await runStatus(agentId)).toBe('awaiting_human');
    expect(mock.transitionsFor(key)).toEqual(['Blocked']);
    expect(panelTypeOf(mock.commentsFor(key)[0])).toBe('warning');

    const tasks = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.ticketId, ticketId), eq(schema.humanTasks.status, 'open')));
    expect(tasks).toHaveLength(1);
  });

  it('NoTransitionPath board config → run recorded failed with the diagnostic, no transition applied', async () => {
    const { key, agentId } = await fireStatusChange({
      name: 'impl-noPath',
      triggerStatus: 'In Progress',
      statusSuccess: 'Code Review',
      statusFailure: 'Ghost Status', // not a real board status → no transition path
      scenario: 'failure',
    });

    // The run finalizes failed; onRunFinished raises NoTransitionPath → error event.
    await waitFor(async () => {
      const errs = await db.db
        .select({ id: schema.runEvents.id, payload: schema.runEvents.payload })
        .from(schema.runEvents)
        .innerJoin(schema.runs, eq(schema.runEvents.runId, schema.runs.id))
        .where(and(eq(schema.runs.agentId, agentId), eq(schema.runEvents.type, 'error')));
      return errs.length > 0;
    });

    expect(await runStatus(agentId)).toBe('failed');
    expect(mock.transitionsFor(key)).toEqual([]); // no transition applied
    expect(mock.commentsFor(key)).toEqual([]); // transition threw before the comment

    const [err] = await db.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .innerJoin(schema.runs, eq(schema.runEvents.runId, schema.runs.id))
      .where(and(eq(schema.runs.agentId, agentId), eq(schema.runEvents.type, 'error')))
      .limit(1);
    expect(JSON.stringify(err.payload)).toMatch(/Ghost Status|no Jira transition/i);
  });
});

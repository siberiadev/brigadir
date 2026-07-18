import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq, asc } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials, JiraClientFactory, type JiraClient } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import { ReconcileService, type WorkspaceContext } from '@brigadir/ingest';
import type { JiraIssue, JiraIssueLink, StatusCategoryKey } from '@brigadir/contracts';
import { slugifyAgentKey } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock-seq.atlassian.net';

const blockedByLink = (blockerKey: string, category: StatusCategoryKey): JiraIssueLink => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: {
    key: blockerKey,
    fields: {
      status: { name: category === 'done' ? 'Done' : 'In Progress', statusCategory: { key: category } },
    },
  },
});

const issueWith = (key: string, status: string, links: JiraIssueLink[]): JiraIssue => ({
  key,
  id: '10000',
  fields: {
    summary: key,
    status: { name: status, statusCategory: { key: 'new' } },
    updated: new Date().toISOString(),
    issuelinks: links,
  },
});

/**
 * Feature 022 (sprint-sequencing) — US1: a blocked-by chain laid out all at
 * once walks itself in order with zero human action (SC-001/SC-003), the
 * post-success fast path releases dependents without a reconcile pass
 * (FR-003), and a fast-path failure never fails run finalization.
 */
describe('sprint sequencing (feature 022)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let pipeline: PipelineService;
  let reconcile: ReconcileService;
  let workspaceId: string;
  let executorId: string;
  let ws: WorkspaceContext;
  let jira: JiraClient;
  let counter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'SEQ' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const [wsRow] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws-seq',
        jiraSiteUrl: BASE,
        jiraProjectKey: 'SEQ',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = wsRow.id;
    ws = { id: workspaceId, projectKey: 'SEQ', boardId: 42, boardType: 'kanban' };

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec-seq', maxParallelRuns: 2 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    pipeline = worker.get(PipelineService, { strict: false });
    reconcile = worker.get(ReconcileService, { strict: false });
    jira = await worker.get(JiraClientFactory, { strict: false }).forWorkspace(workspaceId);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  async function seedAgent(name: string, triggerStatus: string): Promise<string> {
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name,
        key: slugifyAgentKey(name),
        instruction: 'do it',
        triggerStatus,
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'success' },
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    return agent.id;
  }

  async function seedTicket(key: string, lastSeenStatus?: string): Promise<string> {
    const [t] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus })
      .returning({ id: schema.tickets.id });
    return t.id;
  }

  async function runsFor(ticketId: string): Promise<{ id: string; status: string; createdAt: Date }[]> {
    return db.db
      .select({ id: schema.runs.id, status: schema.runs.status, createdAt: schema.runs.createdAt })
      .from(schema.runs)
      .where(eq(schema.runs.ticketId, ticketId))
      .orderBy(asc(schema.runs.createdAt));
  }

  async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('US1: a chain A→B→C laid out at once walks itself in order — zero human action, zero duplicates (SC-001/SC-003)', async () => {
    const status = `Chain Ready ${++counter}`;
    await seedAgent(`chain-worker-${counter}`, status);

    const [keyA, keyB, keyC] = [`SEQ-${++counter}`, `SEQ-${++counter}`, `SEQ-${++counter}`];
    mock.seedIssue(keyA, { status });
    mock.seedIssue(keyB, { status });
    mock.seedIssue(keyC, { status });
    mock.addBlockedByLink(keyB, keyA);
    mock.addBlockedByLink(keyC, keyB);

    const ticketA = await seedTicket(keyA, status);
    const ticketB = await seedTicket(keyB, status);
    const ticketC = await seedTicket(keyC, status);

    // The whole sprint chain enters the trigger status at once (scope entry).
    for (const [ticketId, key, links] of [
      [ticketA, keyA, []],
      [ticketB, keyB, [blockedByLink(keyA, 'new')]],
      [ticketC, keyC, [blockedByLink(keyB, 'new')]],
    ] as const) {
      await pipeline.onStatusChanged({
        ticketId,
        issue: issueWith(key, status, [...links]),
        fromStatus: null,
        toStatus: status,
        source: 'scope_entry',
      });
    }

    // Only A triggers; B and C recorded as waiting on their blockers.
    expect((await runsFor(ticketA)).length).toBe(1);
    expect((await runsFor(ticketB)).length).toBe(0);
    expect((await runsFor(ticketC)).length).toBe(0);

    // No reconcile passes from here on: the post-success fast path must walk
    // the chain on its own (A succeeds → B releases → B succeeds → C releases).
    await waitFor(async () => (await runsFor(ticketC)).some((r) => r.status === 'succeeded'));

    const [runsA, runsB, runsC] = [await runsFor(ticketA), await runsFor(ticketB), await runsFor(ticketC)];
    // Exactly one run per ticket — dedup layers hold across the release wave.
    expect(runsA.length).toBe(1);
    expect(runsB.length).toBe(1);
    expect(runsC.length).toBe(1);
    // Chain order: A started before B, B before C.
    expect(runsA[0].createdAt.getTime()).toBeLessThanOrEqual(runsB[0].createdAt.getTime());
    expect(runsB[0].createdAt.getTime()).toBeLessThanOrEqual(runsC[0].createdAt.getTime());
    // Every ticket walked through the success transition on the board.
    for (const key of [keyA, keyB, keyC]) {
      expect(mock.transitionsFor(key)).toContain('Done');
    }
    // Waiting cache cleared for the released tickets.
    for (const ticketId of [ticketB, ticketC]) {
      const [row] = await db.db
        .select({ blockedState: schema.tickets.blockedState })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId));
      expect(row.blockedState).toBeNull();
    }
  }, 120_000);

  it('US1: fast-path failure never fails finalization; the reconcile pass releases instead (FR-003)', async () => {
    const status = `FP Ready ${++counter}`;
    await seedAgent(`fp-worker-${counter}`, status);

    const [keyG, keyF] = [`SEQ-${++counter}`, `SEQ-${++counter}`];
    mock.seedIssue(keyG, { status });
    mock.seedIssue(keyF, { status });
    mock.addBlockedByLink(keyF, keyG);

    const ticketG = await seedTicket(keyG, status);
    const ticketF = await seedTicket(keyF, status);

    // G triggers; F waits on G.
    await pipeline.onStatusChanged({
      ticketId: ticketG,
      issue: issueWith(keyG, status, []),
      fromStatus: null,
      toStatus: status,
      source: 'scope_entry',
    });
    await pipeline.onStatusChanged({
      ticketId: ticketF,
      issue: issueWith(keyF, status, [blockedByLink(keyG, 'new')]),
      fromStatus: null,
      toStatus: status,
      source: 'scope_entry',
    });

    // Kill the fast path's dependent fetch: the next search 500s.
    mock.arm500OnNextSearch();

    // G's run must still finalize cleanly (transition + comment + marker).
    await waitFor(async () => (await runsFor(ticketG)).some((r) => r.status === 'succeeded'));
    await waitFor(() => mock.transitionsFor(keyG).includes('Done'));
    expect((await runsFor(ticketF)).length).toBe(0); // fast path swallowed the failure

    // The guarantee: the next reconcile pass releases F.
    await reconcile.reEvaluateDependencies(ws, jira);
    expect((await runsFor(ticketF)).length).toBe(1);

    // No duplicate from a follow-up pass.
    await reconcile.reEvaluateDependencies(ws, jira);
    expect((await runsFor(ticketF)).length).toBe(1);
  }, 120_000);

  it('US2: a simultaneously released wave starts in priority order, identically on every repetition (SC-004)', async () => {
    for (let rep = 0; rep < 10; rep += 1) {
      const status = `Wave Ready ${++counter}`;
      await seedAgent(`wave-worker-${counter}`, status);

      const keyBlocker = `SEQ-${++counter}`;
      // Seeded already Done: the wave is clear on the very first release pass.
      mock.seedIssue(keyBlocker, { status: 'Done' });

      // High(2) / Low(4) / no-priority, seeded out of order on purpose.
      const keyLow = `SEQ-${++counter}`;
      const keyHigh = `SEQ-${++counter}`;
      const keyNone = `SEQ-${++counter}`;
      mock.seedIssue(keyLow, { status, priority: { id: '4', name: 'Low' } });
      mock.seedIssue(keyHigh, { status, priority: { id: '2', name: 'High' } });
      mock.seedIssue(keyNone, { status });
      for (const key of [keyLow, keyHigh, keyNone]) mock.addBlockedByLink(key, keyBlocker);

      const ticketIds = new Map<string, string>();
      for (const key of [keyLow, keyHigh, keyNone]) ticketIds.set(key, await seedTicket(key, status));

      await reconcile.reEvaluateDependencies(ws, jira);

      const rows = await db.db
        .select({ ticketId: schema.runs.ticketId, createdAt: schema.runs.createdAt })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.workspaceId, workspaceId),
            eq(schema.runs.agentId, (await db.db
              .select({ id: schema.agents.id })
              .from(schema.agents)
              .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.triggerStatus, status))))[0].id),
          ),
        )
        .orderBy(asc(schema.runs.createdAt));
      const orderedKeys = rows.map(
        (r) => [...ticketIds.entries()].find(([, id]) => id === r.ticketId)?.[0],
      );
      // High priority first, then Low, then no-priority — every repetition.
      expect(orderedKeys).toEqual([keyHigh, keyLow, keyNone]);
    }
  }, 240_000);

  it('US4: a blocked-by cycle starts nothing and both members are flagged (FR-009)', async () => {
    const status = `Cycle Ready ${++counter}`;
    await seedAgent(`cycle-worker-${counter}`, status);

    const [keyX, keyY] = [`SEQ-${++counter}`, `SEQ-${++counter}`];
    mock.seedIssue(keyX, { status });
    mock.seedIssue(keyY, { status });
    mock.addBlockedByLink(keyX, keyY);
    mock.addBlockedByLink(keyY, keyX);
    const ticketX = await seedTicket(keyX, status);
    const ticketY = await seedTicket(keyY, status);

    await reconcile.reEvaluateDependencies(ws, jira);

    for (const ticketId of [ticketX, ticketY]) {
      expect((await runsFor(ticketId)).length).toBe(0);
      const [row] = await db.db
        .select({ blockedState: schema.tickets.blockedState })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId));
      expect(row.blockedState).toBe('cycle');
    }
  });

  it('US4: a blocker resolved OUTSIDE the done category flags a dead end; INTO the done category releases (FR-010)', async () => {
    const status = `Dead Ready ${++counter}`;
    await seedAgent(`dead-worker-${counter}`, status);

    // Dead end: blocker closed as Won't Do into an indeterminate-category status.
    const keyBlocker = `SEQ-${++counter}`;
    const keyDep = `SEQ-${++counter}`;
    mock.setCategory('Rejected', 'indeterminate');
    mock.seedIssue(keyBlocker, { status: 'Rejected' });
    mock.setResolution(keyBlocker, "Won't Do");
    mock.seedIssue(keyDep, { status });
    mock.addBlockedByLink(keyDep, keyBlocker);
    const ticketDep = await seedTicket(keyDep, status);

    await reconcile.reEvaluateDependencies(ws, jira);
    expect((await runsFor(ticketDep)).length).toBe(0);
    const [row] = await db.db
      .select({ blockedState: schema.tickets.blockedState })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketDep));
    expect(row.blockedState).toBe('dead_end');
    // No human task for a dead end — it is a warning, not a task (research R5).
    const tasks = await db.db
      .select({ id: schema.humanTasks.id })
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.ticketId, ticketDep));
    expect(tasks.length).toBe(0);

    // Control: the same resolution INTO the done category is a normal completion.
    mock.moveBlocker(keyBlocker, 'Done', 'done');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect((await runsFor(ticketDep)).length).toBe(1);
  });

  it('US4: an out-of-scope blocker flags the ticket and raises exactly ONE run-less human task (FR-010)', async () => {
    const status = `Scope Ready ${++counter}`;
    await seedAgent(`scope-worker-${counter}`, status);

    // The blocker lives in ANOTHER project — the scope probe (project = "SEQ")
    // will not see it, while the blocker fetch (no project clause) will.
    const keyBlocker = `OTHER-${++counter}`;
    const keyDep = `SEQ-${++counter}`;
    mock.seedIssue(keyBlocker, { status: 'In Progress' });
    mock.seedIssue(keyDep, { status });
    mock.addBlockedByLink(keyDep, keyBlocker);
    const ticketDep = await seedTicket(keyDep, status);

    await reconcile.reEvaluateDependencies(ws, jira);
    const stateOf = async () =>
      (
        await db.db
          .select({ blockedState: schema.tickets.blockedState })
          .from(schema.tickets)
          .where(eq(schema.tickets.id, ticketDep))
      )[0].blockedState;
    const openTasks = async () =>
      db.db
        .select({ id: schema.humanTasks.id, runId: schema.humanTasks.runId, status: schema.humanTasks.status })
        .from(schema.humanTasks)
        .where(and(eq(schema.humanTasks.ticketId, ticketDep), eq(schema.humanTasks.status, 'open')));

    expect(await stateOf()).toBe('out_of_scope');
    expect((await runsFor(ticketDep)).length).toBe(0);
    const tasks1 = await openTasks();
    expect(tasks1.length).toBe(1);
    expect(tasks1[0].runId).toBeNull();

    // Second pass: deduped — still exactly one open task.
    await reconcile.reEvaluateDependencies(ws, jira);
    expect((await openTasks()).length).toBe(1);

    // Human resolves the task WITHOUT fixing the board → a later pass re-creates it.
    await db.db
      .update(schema.humanTasks)
      .set({ status: 'resolved' })
      .where(eq(schema.humanTasks.id, tasks1[0].id));
    await reconcile.reEvaluateDependencies(ws, jira);
    expect((await openTasks()).length).toBe(1);

    // Human breaks the link on the board → state clears and the ticket releases.
    mock.removeBlockedByLink(keyDep, keyBlocker);
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await stateOf()).toBeNull();
    expect((await runsFor(ticketDep)).length).toBe(1);
  });

  it('US1: waiting ticket shows its blocker keys while parked (FR-001)', async () => {
    const status = `Wait Ready ${++counter}`;
    await seedAgent(`wait-worker-${counter}`, status);

    const [keyBlocker, keyWaiter] = [`SEQ-${++counter}`, `SEQ-${++counter}`];
    mock.seedIssue(keyBlocker, { status: 'In Progress' });
    mock.seedIssue(keyWaiter, { status });
    mock.addBlockedByLink(keyWaiter, keyBlocker);
    const ticketW = await seedTicket(keyWaiter, status);

    await pipeline.onStatusChanged({
      ticketId: ticketW,
      issue: issueWith(keyWaiter, status, [blockedByLink(keyBlocker, 'indeterminate')]),
      fromStatus: null,
      toStatus: status,
      source: 'scope_entry',
    });

    const [row] = await db.db
      .select({ blockedBy: schema.tickets.blockedBy, blockedState: schema.tickets.blockedState })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.id, ticketW), eq(schema.tickets.workspaceId, workspaceId)));
    expect(row.blockedState).toBe('waiting');
    expect(row.blockedBy).toEqual([keyBlocker]);
  });
});

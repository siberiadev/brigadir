import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
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

const BASE = 'https://mock.atlassian.net';

const blockedByLink = (blockerKey: string, category: StatusCategoryKey): JiraIssueLink => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: {
    key: blockerKey,
    fields: { status: { name: category === 'done' ? 'Done' : 'In Progress', statusCategory: { key: category } } },
  },
});

const relatesLink = (otherKey: string): JiraIssueLink => ({
  type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
  inwardIssue: { key: otherKey, fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } },
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
 * T057 (trigger side, US7) + T066 (reconcile side, US7). The dependency gate:
 *  - a ticket in a trigger status with an open "is blocked by" blocker enqueues
 *    NO run; non-blocking links fire normally (FR-034/035);
 *  - a previously-blocked ticket whose blocker moves to Done fires EXACTLY ONCE
 *    on the next reconcile pass, and zero on the pass after (FR-036, SC-010) —
 *    even though the blocked ticket's own `updated` never changed.
 */
describe('dependency gate (T057 trigger-side, T066 reconcile-side)', () => {
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

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const [wsRow] = await db.db
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
    workspaceId = wsRow.id;
    ws = { id: workspaceId, projectKey: 'BRIG', boardId: 42, boardType: 'kanban' };

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 2 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    // Neuter the periodic reconcile scheduler: these tests drive reconcile
    // explicitly, so a background poll must not cross-trigger agents.
    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    pipeline = worker.get(PipelineService, { strict: false });
    reconcile = worker.get(ReconcileService, { strict: false });
    // Feature 006: reEvaluateDependencies now takes the per-workspace client.
    jira = await worker.get(JiraClientFactory, { strict: false }).forWorkspace(workspaceId);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  // A distinct trigger status per agent so agents never cross-trigger each other.
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
        statusSuccess: 'Code Review',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'success' },
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    return agent.id;
  }

  async function runCount(agentId: string): Promise<number> {
    const rows = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentId));
    return rows.length;
  }

  async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ---- T057: trigger side ----

  it('trigger side: an open "is blocked by" blocker enqueues no run and persists the waiting state', async () => {
    const status = 'Ready A';
    const agentId = await seedAgent('gate-blocked', status);
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });

    await pipeline.onStatusChanged({
      ticketId: ticket.id,
      issue: issueWith(key, status, [blockedByLink('BLK-1', 'indeterminate')]),
      fromStatus: null,
      toStatus: status,
      source: 'scope_entry',
    });

    expect(await runCount(agentId)).toBe(0);
    // Feature 022 (FR-001): the skip is recorded, not dropped.
    const [row] = await db.db
      .select({ blockedBy: schema.tickets.blockedBy, blockedState: schema.tickets.blockedState })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticket.id));
    expect(row.blockedState).toBe('waiting');
    expect(row.blockedBy).toEqual(['BLK-1']);
  });

  it('trigger side: a ticket with only non-blocking links fires normally', async () => {
    const status = 'Ready B';
    const agentId = await seedAgent('gate-clear', status);
    const key = `BRIG-${++counter}`;
    mock.seedIssue(key, { status });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key })
      .returning({ id: schema.tickets.id });

    await pipeline.onStatusChanged({
      ticketId: ticket.id,
      issue: issueWith(key, status, [relatesLink('BRIG-999')]),
      fromStatus: null,
      toStatus: status,
      source: 'scope_entry',
    });

    expect(await runCount(agentId)).toBe(1);
  });

  // ---- T066: reconcile side ----

  it('reconcile side: blocked until blocker→Done, then fires exactly once (SC-010)', async () => {
    const status = 'Ready C';
    const agentId = await seedAgent('gate-reeval', status);
    const key = `BRIG-${++counter}`;
    // In-project key: the reconcile-side path runs the scope probe
    // (DependencyReleaseService.classifyWaiting), and the mock's JQL project
    // clause matches by key prefix — an out-of-project blocker (e.g. `BLK-…`)
    // is legitimately classified `out_of_scope`, not `waiting` (that branch is
    // exercised deliberately in sprint-sequencing.spec.ts with an `OTHER-` key).
    const blockerKey = `BRIG-${900 + counter}`;

    // The blocked ticket sits in the trigger status; its `updated` never changes.
    mock.seedIssue(key, { status, updated: '2026-01-01T00:00:00.000Z' });
    mock.seedIssue(blockerKey, { status: 'In Progress' });
    mock.addBlockedByLink(key, blockerKey);
    await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: status });

    // Pass 1: blocker still open → no run; waiting cache kept current (022).
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(0);
    const waitingRow = async () =>
      (
        await db.db
          .select({ blockedBy: schema.tickets.blockedBy, blockedState: schema.tickets.blockedState })
          .from(schema.tickets)
          .where(and(eq(schema.tickets.workspaceId, workspaceId), eq(schema.tickets.jiraKey, key)))
      )[0];
    expect((await waitingRow()).blockedState).toBe('waiting');
    expect((await waitingRow()).blockedBy).toEqual([blockerKey]);

    // Blocker resolves (only the blocker's status changes).
    mock.moveBlocker(blockerKey, 'Done', 'done');

    // Pass 2: now clear → fires exactly once; waiting cache cleared (022).
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1);
    expect((await waitingRow()).blockedState).toBeNull();
    // Feature 032 (data-model.md §2): `blocked_by` is an OBSERVATION and
    // survives the release — `blocked_state` alone signals waiting. Before 032
    // this column was nulled here, which is exactly what made the dependent's
    // prepare step unable to find its blocker's branch.
    expect((await waitingRow()).blockedBy).toEqual([blockerKey]);

    // Pass 3: an active/succeeded run now exists → zero additional.
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1);

    // The run completes cleanly (blocked ticket now transitions on success).
    await waitFor(() => mock.transitionsFor(key).includes('Code Review'));
  });

  // ---- Feature 032 (T011): the configurable release threshold ----

  /** Set / clear `settings.dependency_release_status` for this workspace. */
  async function setReleaseStatus(value: string | null): Promise<void> {
    const [row] = await db.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    const settings = { ...((row.settings as Record<string, unknown>) ?? {}) };
    if (value === null) delete settings.dependency_release_status;
    else settings.dependency_release_status = value;
    await db.db
      .update(schema.workspaces)
      .set({ settings })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  /** A trigger-status ticket + its blocker, wired both in the mock and the cache. */
  async function seedChain(
    status: string,
    blockerStatus: string,
  ): Promise<{ key: string; blockerKey: string }> {
    const key = `BRIG-${++counter}`;
    const blockerKey = `BRIG-${900 + counter}`;
    mock.seedIssue(key, { status, updated: '2026-01-01T00:00:00.000Z' });
    mock.seedIssue(blockerKey, { status: blockerStatus });
    mock.addBlockedByLink(key, blockerKey);
    await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: status });
    return { key, blockerKey };
  }

  async function earlyReleaseEvents(agentId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.db
      .select({ payload: schema.runEvents.payload, runId: schema.runEvents.runId })
      .from(schema.runEvents)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.runEvents.runId))
      .where(eq(schema.runs.agentId, agentId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === 'dependency-release');
  }

  it('releases a dependent once its blocker reaches the configured status (not done)', async () => {
    const status = 'Ready D';
    const agentId = await seedAgent('gate-configured', status);
    const { key, blockerKey } = await seedChain(status, 'In Progress');
    mock.setCategory('In Review', 'indeterminate');
    await setReleaseStatus('In Review');

    // Blocker below the threshold → nothing fires.
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(0);

    mock.moveBlocker(blockerKey, 'In Review', 'indeterminate');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1);

    // FR-015: the run carries the early-release annotation naming the status.
    const events = await earlyReleaseEvents(agentId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ early: true, matched_status: 'In Review' });
    expect(events[0].blockers).toEqual([{ key: blockerKey, status: 'In Review' }]);

    await waitFor(() => mock.transitionsFor(key).includes('Code Review'));
    await setReleaseStatus(null);
  });

  it('the SAME fixture keeps waiting when the setting is unset (FR-016 regression)', async () => {
    const status = 'Ready E';
    const agentId = await seedAgent('gate-unset', status);
    const { blockerKey } = await seedChain(status, 'In Progress');
    mock.setCategory('In Review', 'indeterminate');
    await setReleaseStatus(null);

    mock.moveBlocker(blockerKey, 'In Review', 'indeterminate');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(0);
  });

  it('matches the configured status case-insensitively', async () => {
    const status = 'Ready F';
    const agentId = await seedAgent('gate-ci', status);
    const { blockerKey } = await seedChain(status, 'In Progress');
    mock.setCategory('IN REVIEW', 'indeterminate');
    await setReleaseStatus('in review');

    mock.moveBlocker(blockerKey, 'IN REVIEW', 'indeterminate');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1);
    await setReleaseStatus(null);
  });

  it('releases a blocker that jumps straight to Done, never observed in the configured status', async () => {
    const status = 'Ready G';
    const agentId = await seedAgent('gate-skip', status);
    const { blockerKey } = await seedChain(status, 'In Progress');
    await setReleaseStatus('In Review');

    mock.moveBlocker(blockerKey, 'Done', 'done');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1);
    // Done-category release ⇒ no early-release annotation (today's clean shape).
    expect(await earlyReleaseEvents(agentId)).toEqual([]);
    await setReleaseStatus(null);
  });

  it('stays blocked while ANY blocker is below the threshold', async () => {
    const status = 'Ready H';
    const agentId = await seedAgent('gate-two-blockers', status);
    const key = `BRIG-${++counter}`;
    const first = `BRIG-${800 + counter}`;
    const second = `BRIG-${850 + counter}`;
    mock.seedIssue(key, { status, updated: '2026-01-01T00:00:00.000Z' });
    mock.seedIssue(first, { status: 'In Progress' });
    mock.seedIssue(second, { status: 'In Progress' });
    mock.addBlockedByLink(key, first);
    mock.addBlockedByLink(key, second);
    await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: status });
    mock.setCategory('In Review', 'indeterminate');
    await setReleaseStatus('In Review');

    mock.moveBlocker(first, 'In Review', 'indeterminate');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(0);

    mock.moveBlocker(second, 'In Review', 'indeterminate');
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1);
    await setReleaseStatus(null);
  });

  // ---- SXF-1174 Problem 5: cancel sticks against the release pass ----

  it('a cancelled run suppresses the release pass; a genuine status change re-arms (SXF-1174 Problem 5)', async () => {
    const status = 'Ready for Cancel-Test';
    const agentId = await seedAgent('gate-cancelled', status);
    const key = `BRIG-${++counter}`;
    // Gate is clear (no links): without the fix the standing-state candidates
    // query would re-trigger this pair on every pass.
    mock.seedIssue(key, { status });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: status })
      .returning({ id: schema.tickets.id });
    // The human cancelled the agent's run while the ticket still sits in the
    // trigger status — the exact incident state (mimir respawned in 13 s).
    await db.db.insert(schema.runs).values({
      workspaceId,
      ticketId: ticket.id,
      agentId,
      executorType: 'mock',
      status: 'cancelled',
      finishedAt: sql`now()`,
      triggerEvent: { source: 'poll' },
    });

    // Two release passes: the cancel sticks — nothing is re-triggered.
    await reconcile.reEvaluateDependencies(ws, jira);
    await reconcile.reEvaluateDependencies(ws, jira);
    expect(await runCount(agentId)).toBe(1); // only the seeded cancelled run

    // A genuine observed status change re-arms the pair via the poller path
    // (the cancelled run is not active, so runs_one_active does not block).
    await pipeline.onStatusChanged({
      ticketId: ticket.id,
      issue: issueWith(key, status, []),
      fromStatus: 'In Progress',
      toStatus: status,
      source: 'poller',
    });
    expect(await runCount(agentId)).toBe(2);
  });
});

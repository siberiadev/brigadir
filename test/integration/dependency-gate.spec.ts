import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import { ReconcileService, type WorkspaceContext } from '@brigadir/ingest';
import type { JiraIssue, JiraIssueLink, StatusCategoryKey } from '@brigadir/contracts';
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
      .values({ workspaceId, type: 'mock', name: 'mock-exec', concurrencyLimit: 2 })
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

  it('trigger side: an open "is blocked by" blocker enqueues no run', async () => {
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
    const blockerKey = `BLK-${counter}`;

    // The blocked ticket sits in the trigger status; its `updated` never changes.
    mock.seedIssue(key, { status, updated: '2026-01-01T00:00:00.000Z' });
    mock.seedIssue(blockerKey, { status: 'In Progress' });
    mock.addBlockedByLink(key, blockerKey);
    await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: status });

    // Pass 1: blocker still open → no run.
    await reconcile.reEvaluateDependencies(ws);
    expect(await runCount(agentId)).toBe(0);

    // Blocker resolves (only the blocker's status changes).
    mock.moveBlocker(blockerKey, 'Done', 'done');

    // Pass 2: now clear → fires exactly once.
    await reconcile.reEvaluateDependencies(ws);
    expect(await runCount(agentId)).toBe(1);

    // Pass 3: an active/succeeded run now exists → zero additional.
    await reconcile.reEvaluateDependencies(ws);
    expect(await runCount(agentId)).toBe(1);

    // The run completes cleanly (blocked ticket now transitions on success).
    await waitFor(() => mock.transitionsFor(key).includes('Code Review'));
  });
});

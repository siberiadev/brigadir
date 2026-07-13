import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import type { JiraIssue } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const issueAt = (key: string, status: string): JiraIssue => ({
  key,
  id: '10000',
  fields: { summary: key, status: { name: status, statusCategory: { key: 'new' } }, updated: new Date().toISOString(), issuelinks: [] },
});

/**
 * T144 (mandatory — hot-reload FR-026, task (f); SC-006): an agent created — and
 * later edited — through the API is picked up on the next poller/reconcile pass
 * with NO backend/worker restart, because config is read per-pass from the DB.
 */
describe('hot-reload: API-created/edited agent picked up next pass (T144)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let worker: TestingModule;
  let pipeline: PipelineService;
  let url: string;
  let workspaceId: string;
  let executorId: string;
  let theMock: MockJira;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const mock: MockJira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    theMock = mock;

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: mock.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;
    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 2 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;

    const backendModule: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    url = await backend.getUrl();

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    pipeline = worker.get(PipelineService, { strict: false });
  }, 300_000);

  afterAll(async () => {
    theMock?.server.close();
    await worker?.close();
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function runExistsForAgent(agentId: string): Promise<boolean> {
    const rows = await db.db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.agentId, agentId)).limit(1);
    return rows.length > 0;
  }

  async function driveStatusChange(ticketKey: string, status: string): Promise<void> {
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: ticketKey, jiraId: '10000', summary: ticketKey })
      .onConflictDoNothing()
      .returning({ id: schema.tickets.id });
    const ticketId =
      ticket?.id ??
      (await db.db.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.workspaceId, workspaceId), eq(schema.tickets.jiraKey, ticketKey))).limit(1))[0].id;
    await pipeline.onStatusChanged({ ticketId, issue: issueAt(ticketKey, status), fromStatus: null, toStatus: status, source: 'scope_entry' });
  }

  async function waitFor(pred: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await pred()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('a newly API-created agent triggers on the next pass (no restart)', async () => {
    const created = await (
      await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspace_id: workspaceId,
          executor_id: executorId,
          name: 'Fresh',
          instruction: 'do it',
          trigger_status: 'Ready for Dev',
          status_success: 'Code Review',
          status_failure: 'Blocked',
          behavior: { mock_scenario: 'success' },
        }),
      })
    ).json();
    expect(created.id).toBeTruthy();

    await driveStatusChange('BRIG-1', 'Ready for Dev');
    await waitFor(() => runExistsForAgent(created.id));
  });

  it('an edited agent uses the new trigger_status on the next pass', async () => {
    const created = await (
      await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspace_id: workspaceId,
          executor_id: executorId,
          name: 'Editable',
          instruction: 'do it',
          trigger_status: 'Backlog',
          status_success: 'Code Review',
          status_failure: 'Blocked',
          behavior: { mock_scenario: 'success' },
        }),
      })
    ).json();

    // Edit the trigger to a different status — no restart.
    await fetch(`${url}/api/agents/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        workspace_id: workspaceId,
        executor_id: executorId,
        name: 'Editable',
        instruction: 'do it',
        trigger_status: 'In Progress',
        status_success: 'Code Review',
        status_failure: 'Blocked',
        behavior: { mock_scenario: 'success' },
      }),
    });

    await driveStatusChange('BRIG-2', 'In Progress');
    await waitFor(() => runExistsForAgent(created.id));
  });
});

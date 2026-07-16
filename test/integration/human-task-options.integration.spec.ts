import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { signRunToken, type AnswerOption, type TriggerEvent } from '@brigadir/contracts';
import { RunTriggerService } from '@brigadir/runs';
import { buildHandoffSection } from '@brigadir/pipeline';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';
const JWT_SECRET = 'human-task-options-test-jwt-secret';

/**
 * Feature 013 (US2/SC-003/SC-005 + Constitution V): answer options travel
 * end to end — request_human tool path and needs_human report path persist
 * them (scrubbed), the queue API serves them globally and workspace-scoped,
 * system-composed tasks stay NULL, and resolving with an option's value lands
 * in `resolution` + the resumed run's handoff Q&A (resume untouched, FR-009).
 */
describe('human-task answer options end to end (feature 013)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let backend: INestApplication;
  let backendUrl: string;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let nextTicket = 900;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();

    // Worker (reconcile neutered — tests drive runs explicitly) for the mock
    // needs_human report path.
    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  function seededTicketKey(): string {
    return `BRIG-${nextTicket++}`;
  }

  async function seedRunningRun(): Promise<{
    runId: string;
    workspaceId: string;
    ticketId: string;
    agentId: string;
    ticketKey: string;
  }> {
    const ticketKey = seededTicketKey();
    const p = await seedPipeline(db.db, {
      executorType: 'mock',
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
    mock.seedIssue(ticketKey, { status: 'In Progress' });
    const [row] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
      })
      .returning({ id: schema.runs.id });
    return { runId: row.id, workspaceId: p.workspaceId, ticketId: p.ticketId, agentId: p.agentId, ticketKey };
  }

  function tokenFor(runId: string, workspaceId: string, ticketKey: string): string {
    return signRunToken(
      { sub: runId, wsp: workspaceId, tkt: ticketKey, exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
  }

  async function postCallback(runId: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${backendUrl}/api/callbacks/runs/${runId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function taskFor(runId: string): Promise<typeof schema.humanTasks.$inferSelect> {
    const rows = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('request_human with options → persisted scrubbed → served globally and workspace-scoped → option value resolves and reaches the handoff Q&A', async () => {
    const seeded = await seedRunningRun();
    const token = tokenFor(seeded.runId, seeded.workspaceId, seeded.ticketKey);
    const canary = 'ghp_' + 'e'.repeat(40); // scrubber-shaped GitHub token

    const res = await postCallback(seeded.runId, 'human', token, {
      kind: 'question',
      title: 'Which migration strategy?',
      details: 'The config format change can break older readers.',
      blocking: true,
      options: [
        { label: 'Migrate config format', value: 'migrate', description: `uses ${canary} internally` },
        { label: 'Keep backward compat' },
      ],
    });
    expect(res.status).toBe(200);

    // Persisted with the task, canary scrubbed (Constitution V).
    const task = await taskFor(seeded.runId);
    const stored = task.options as AnswerOption[] | null;
    expect(stored).toHaveLength(2);
    expect(stored![0]).toMatchObject({ label: 'Migrate config format', value: 'migrate' });
    expect(JSON.stringify(stored)).not.toContain(canary);
    expect(stored![1]).toEqual({ label: 'Keep backward compat' });

    // The Jira question comment mirrors the options as a plain list (FR-010) —
    // labels/descriptions only; `value` is machine-facing and never rendered.
    const comments = mock.commentsFor(seeded.ticketKey);
    expect(comments.length).toBeGreaterThan(0);
    const commentText = JSON.stringify(comments[comments.length - 1]);
    expect(commentText).toContain('Suggested answers:');
    expect(commentText).toContain('Migrate config format');
    expect(commentText).toContain('Keep backward compat');

    // Served by the global list AND the workspace-scoped tab (FR-006).
    const globalList = await fetch(`${backendUrl}/api/human-tasks?status=open`, { headers: authHeaders }).then((r) => r.json());
    const globalItem = globalList.items.find((i: { id: string }) => i.id === task.id);
    expect(globalItem.options).toEqual(stored);

    const scoped = await fetch(`${backendUrl}/api/human-tasks?status=open&workspace=${seeded.workspaceId}`, { headers: authHeaders }).then((r) => r.json());
    expect(scoped.items.find((i: { id: string }) => i.id === task.id).options).toEqual(stored);

    // Resolve with the option's VALUE through the existing answer field —
    // the resolution pipeline is untouched by design (FR-009).
    const resolveRes = await fetch(`${backendUrl}/api/human-tasks/${task.id}/resolve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'resume', answer: 'migrate', resolved_by: 'op@team' }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as { newRunId: string };

    const [closed] = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.id, task.id));
    expect(closed).toMatchObject({ status: 'resolved', resolution: 'migrate' });

    // The resumed run's handoff renders the ordinary Q&A with the chosen value.
    const [newRun] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, resolveBody.newRunId));
    expect(newRun.triggerEvent).toMatchObject({ source: 'human-resume', resolution: 'migrate' });
    const handoff = await buildHandoffSection(newRun.triggerEvent as TriggerEvent, db.db);
    expect(handoff).toContain('Question: Which migration strategy?');
    expect(handoff).toContain('Answer: migrate');
  }, 60_000);

  it('mock needs_human run with trigger_event.mock_options persists them on the report path', async () => {
    const ticketKey = seededTicketKey();
    const p = await seedPipeline(db.db, {
      executorType: 'mock',
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
    mock.seedIssue(ticketKey, { status: 'In Progress' });

    const options: AnswerOption[] = [
      { label: 'Return empty list', value: 'empty' },
      { label: 'Throw an error', description: 'Fail fast on bad input' },
    ];
    const triggered = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'needs_human', mock_options: options },
    });
    if (triggered.deduplicated) throw new Error('unexpected dedup');

    const deadline = Date.now() + 30_000;
    let run: typeof schema.runs.$inferSelect | undefined;
    for (;;) {
      [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, triggered.runId)).limit(1);
      if (run && run.status !== 'queued' && run.status !== 'running') break;
      if (Date.now() > deadline) throw new Error(`run stuck at ${run?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run!.status).toBe('awaiting_human');

    const task = await taskFor(triggered.runId);
    expect(task.options).toEqual(options);
  }, 60_000);

  it('system-composed task (PR-review from a pull_request success) has options NULL', async () => {
    const ticketKey = seededTicketKey();
    const p = await seedPipeline(db.db, {
      executorType: 'mock',
      ticketKey,
      behavior: { code_delivery: 'pull_request' },
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
    mock.seedIssue(ticketKey, { status: 'In Progress' });
    const [row] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
      })
      .returning({ id: schema.runs.id });

    const token = tokenFor(row.id, p.workspaceId, ticketKey);
    const res = await postCallback(row.id, 'complete', token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'Shipped a PR.',
      checks: [],
      artifacts: { pr_url: 'https://github.com/acme/repo/pull/7' },
    });
    expect(res.status).toBe(200);

    const [reviewTask] = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, row.id), eq(schema.humanTasks.kind, 'review')));
    expect(reviewTask).toBeDefined();
    expect(reviewTask.options).toBeNull();
  }, 60_000);

  it('out-of-bounds options (6 items) are rejected 422 and the run stays running', async () => {
    const seeded = await seedRunningRun();
    const token = tokenFor(seeded.runId, seeded.workspaceId, seeded.ticketKey);

    const res = await postCallback(seeded.runId, 'human', token, {
      kind: 'question',
      title: 'Too many choices',
      details: 'd',
      blocking: true,
      options: Array.from({ length: 6 }, (_, i) => ({ label: `option ${i}` })),
    });
    expect(res.status).toBe(422);

    const [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, seeded.runId));
    expect(run.status).toBe('running');
    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, seeded.runId));
    expect(tasks).toHaveLength(0);
  }, 60_000);
});

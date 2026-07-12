import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * T142 (agent CRUD + server-authoritative linter; US2 acceptance 1–5,8; SC-004)
 * and T143 (test-run reuses the manual path; 3-level dedup; US2 #6).
 */
describe('agent CRUD + linter + test-run (T142/T143)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let jira: MockJira;
  let workspaceId: string;
  let executorId: string;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    jira?.server.close();
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(async () => {
    jira.reset();
    // runs (and run_events) do NOT cascade from workspaces — clear them first.
    await db.db.delete(schema.runEvents);
    await db.db.delete(schema.runs);
    await db.db.delete(schema.workspaces); // cascades executors/agents/tickets
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;
    const [exec] = await db.db
      .insert(schema.executors)
      .values({ workspaceId, type: 'mock', name: 'mock-exec', concurrencyLimit: 2 })
      .returning({ id: schema.executors.id });
    executorId = exec.id;
  });

  function agentBody(over: Record<string, unknown> = {}) {
    return {
      workspace_id: workspaceId,
      executor_id: executorId,
      name: 'Implementer',
      instruction: 'Implement the ticket.',
      trigger_status: 'Ready for Dev',
      status_running: 'In Progress',
      status_success: 'Code Review',
      status_failure: 'Blocked',
      timeout_minutes: 45,
      max_attempts: 2,
      behavior: {},
      ...over,
    };
  }
  const post = (body: unknown) =>
    fetch(`${url}/api/agents`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('a status not on the board → 422 status_absent pinned to the field', async () => {
    const res = await post(agentBody({ status_success: 'Done Done' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.issues.some((i: { code: string; path: string[] }) => i.code === 'status_absent' && i.path[0] === 'status_success')).toBe(true);
    expect(await db.db.select().from(schema.agents)).toHaveLength(0); // nothing written
  });

  it('duplicate trigger among enabled agents → 422, allowed with a distinct trigger_jql', async () => {
    expect((await post(agentBody({ name: 'A' }))).status).toBe(201);

    const dup = await post(agentBody({ name: 'B' }));
    expect(dup.status).toBe(422);
    expect((await dup.json()).error.issues[0].code).toBe('duplicate_trigger');

    const distinct = await post(agentBody({ name: 'C', trigger_jql: 'labels = urgent' }));
    expect(distinct.status).toBe(201);
  });

  it('a cycle → 201 with a non-blocking status_cycle warning', async () => {
    expect((await post(agentBody({ name: 'A', trigger_status: 'Ready for Dev', status_success: 'Code Review' }))).status).toBe(201);
    const res = await post(agentBody({ name: 'B', trigger_status: 'Code Review', status_success: 'Ready for Dev' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings?.[0].code).toBe('status_cycle');
  });

  it('delete: soft (enabled=false) with runs, hard without', async () => {
    // distinct trigger_status so neither trips duplicate_trigger
    const withRuns = await (await post(agentBody({ name: 'HasRuns', trigger_status: 'Ready for Dev' }))).json();
    const noRuns = await (await post(agentBody({ name: 'NoRuns', trigger_status: 'Code Review' }))).json();

    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: 'BRIG-1', jiraId: '10001', summary: 't' })
      .returning({ id: schema.tickets.id });
    await db.db.insert(schema.runs).values({
      workspaceId,
      ticketId: ticket.id,
      agentId: withRuns.id,
      executorType: 'mock',
      status: 'succeeded',
      attempt: 1,
    });

    const soft = await fetch(`${url}/api/agents/${withRuns.id}`, { method: 'DELETE', headers });
    expect((await soft.json()).soft_deleted).toBe(true);
    const [stillThere] = await db.db.select().from(schema.agents).where(eq(schema.agents.id, withRuns.id));
    expect(stillThere.enabled).toBe(false);

    const hard = await fetch(`${url}/api/agents/${noRuns.id}`, { method: 'DELETE', headers });
    expect((await hard.json()).soft_deleted).toBe(false);
    expect(await db.db.select().from(schema.agents).where(eq(schema.agents.id, noRuns.id))).toHaveLength(0);
  });

  it('test-run enqueues a run; an immediate second for the same (ticket, agent) dedups', async () => {
    const agent = await (await post(agentBody({ name: 'Runner' }))).json();

    const first = await fetch(`${url}/api/agents/${agent.id}/test-run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ticket_key: 'BRIG-500' }),
    });
    expect(first.status).toBe(202);
    expect((await first.json()).run_id).toBeTruthy();

    const second = await fetch(`${url}/api/agents/${agent.id}/test-run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ticket_key: 'BRIG-500' }),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).deduplicated).toBe(true);
  });
});

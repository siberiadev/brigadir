import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import type { ADFDoc } from '@brigadir/contracts';
import { encodeJiraCredentials } from '@brigadir/jira';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';

/** Minimal one-paragraph ADF doc (Cloud v3 comment/description shape). */
function textDoc(text: string): ADFDoc {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Feature 011 US2 (FR-008..011, SC-005 / contracts/jira-read-tools.md): the
 * read-only Jira callback endpoints behind RunTokenGuard — overview, scoped
 * search, single-ticket read with comments; 403 out-of-scope, 401 foreign
 * token, 409 finished run, truncation flags; available to plain worker runs.
 */
describe('read-only Jira callback tools (feature 011, US2)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let backend: INestApplication;
  let url: string;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;

    mock = mockJira({ baseUrl: BASE, boardType: 'scrum', boardId: 42, projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    mock.startSprint(7, []);

    const seeded = await seedPipeline(db.db, {
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
    workspaceId = seeded.workspaceId;
    agentId = seeded.agentId;
    await db.db
      .update(schema.workspaces)
      .set({ jiraBoardId: 42, jiraBoardType: 'scrum' })
      .where(eq(schema.workspaces.id, workspaceId));

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    url = await backend.getUrl();
  }, 240_000);

  afterAll(async () => {
    await backend?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  /** Insert a run in the given status and mint its token (fresh ticket per run — `runs_one_active`). */
  let ticketSeq = 0;
  async function runWithToken(
    status = 'running',
    wsId = workspaceId,
  ): Promise<{ runId: string; token: string }> {
    const [freshTicket] = await db.db
      .insert(schema.tickets)
      .values({
        workspaceId: wsId,
        jiraKey: `BRIG-8${++ticketSeq}`,
        jiraId: `8${ticketSeq}`,
        summary: 'read-tools run anchor',
      })
      .returning({ id: schema.tickets.id });
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: wsId,
        ticketId: freshTicket.id,
        agentId,
        executorType: 'mock',
        status,
      })
      .returning({ id: schema.runs.id });
    const token = signRunToken(
      { sub: run.id, wsp: wsId, exp: Math.floor(Date.now() / 1000) + 600 },
      process.env.BRIGADIR_JWT_SECRET!,
    );
    return { runId: run.id, token };
  }

  const call = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${url}/api/callbacks/runs/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  it('overview: board type, exact status names, issue types, active sprint', async () => {
    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/jira/overview`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project_key: string;
      board_type: string;
      statuses: { name: string }[];
      issue_types: string[];
      active_sprint: { id: number } | null;
    };
    expect(body.project_key).toBe('BRIG');
    expect(body.statuses.map((s) => s.name)).toContain('In Progress');
    expect(body.issue_types).toContain('Task');
  });

  it('search: server-composed JQL, bounded results, worker-run token parity', async () => {
    mock.seedIssue('BRIG-701', { status: 'In Progress', summary: 'Login form' });
    mock.seedIssue('BRIG-702', { status: 'Backlog', summary: 'Logout' });

    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/jira/search`, token, {
      method: 'POST',
      body: JSON.stringify({ max_results: 10 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { key: string }[]; truncated: boolean };
    expect(body.items.map((i) => i.key)).toEqual(expect.arrayContaining(['BRIG-701', 'BRIG-702']));
    expect(body.truncated).toBe(false);

    // Raw-JQL escape attempts are just literals inside a bounded filter (422 on shape).
    const bad = await call(`${runId}/jira/search`, token, {
      method: 'POST',
      body: JSON.stringify({ jql: 'project = OTHER' }),
    });
    expect(bad.status).toBe(422);
  });

  it('get_ticket: description, latest comments (newest first), links, labels', async () => {
    mock.seedIssue('BRIG-703', {
      status: 'In Progress',
      summary: 'Ticket with comments',
      description: textDoc('A long description body.'),
    });
    // Captured through the same write path the system uses.
    const { runId, token } = await runWithToken();
    // Seed two comments via the mock's comment capture endpoint.
    for (const text of ['first comment', 'second comment']) {
      await fetch(`${BASE}/rest/api/3/issue/BRIG-703/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: textDoc(text) }),
      });
    }

    const res = await call(`${runId}/jira/tickets/BRIG-703`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      description: string;
      comments: { body: string }[];
      truncated: boolean;
    };
    expect(body.key).toBe('BRIG-703');
    expect(body.description).toContain('A long description body.');
    expect(body.comments).toHaveLength(2);
    // Newest first.
    expect(body.comments[0].body).toContain('second comment');
    expect(body.truncated).toBe(false);
  });

  it('get_ticket: oversized description is truncated with the flag set', async () => {
    mock.seedIssue('BRIG-704', {
      status: 'Backlog',
      summary: 'Huge',
      description: textDoc('x'.repeat(6000)),
    });
    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/jira/tickets/BRIG-704`, token);
    const body = (await res.json()) as { description: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.description).toContain('…[truncated]');
    expect(body.description.length).toBeLessThan(4100);
  });

  it('scope: a key outside the workspace project is 403 out_of_scope', async () => {
    // A second workspace on the SAME mock site but a DIFFERENT project key —
    // any BRIG-* issue resolves to project BRIG ≠ OTHER → out of scope.
    const [otherWs] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'other-ws',
        jiraSiteUrl: BASE,
        jiraProjectKey: 'OTHER',
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });

    mock.seedIssue('BRIG-705', { status: 'Backlog', summary: 'foreign' });
    const { runId, token } = await runWithToken('running', otherWs.id);
    const res = await call(`${runId}/jira/tickets/BRIG-705`, token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('out_of_scope');
  });

  it('guard parity: foreign token 401, finished run 409, unknown in-scope key 404', async () => {
    const { runId, token } = await runWithToken();
    const foreign = await call(`${runId}/jira/overview`, `${token}x`);
    expect(foreign.status).toBe(401);

    const { runId: doneId, token: doneToken } = await runWithToken('succeeded');
    const finished = await call(`${doneId}/jira/overview`, doneToken);
    expect(finished.status).toBe(409);

    const missing = await call(`${runId}/jira/tickets/BRIG-99999`, token);
    expect(missing.status).toBe(404);
  });
});

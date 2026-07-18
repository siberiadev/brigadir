import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';
const JWT_SECRET = 'callback-scrubbing-test-jwt-secret';
const PLANTED_SECRET_1 = 'sk-ant-' + 'a'.repeat(30);
const PLANTED_SECRET_2 = 'ghp_' + 'b'.repeat(40);

/**
 * T113 (US5, FR-024, SC-005) — every free-text field the agent sends is
 * scrubbed before persistence and before any Jira write; 0 leaks across the
 * corpus, verified at every point the agent's words leave the run boundary.
 */
describe('secret scrubbing at the run boundary (T113)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let backend: INestApplication;
  let backendUrl: string;
  let nextTicket = 1000;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const backendModule: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();
  }, 240_000);

  afterAll(async () => {
    await backend?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  async function seedRunningRun(): Promise<{ runId: string; workspaceId: string; ticketKey: string }> {
    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress' });
    const p = await seedPipeline(db.db, {
      executorType: 'mock',
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
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
    return { runId: row.id, workspaceId: p.workspaceId, ticketKey };
  }

  function tokenFor(runId: string, workspaceId: string, ticketKey: string): string {
    return signRunToken(
      { sub: runId, wsp: workspaceId, tkt: ticketKey, exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
  }

  async function post(runId: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${backendUrl}/api/callbacks/runs/${runId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('a completion report with planted secrets is scrubbed in the persisted row and the Jira comment', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await post(runId, 'complete', token, {
      schema_version: 1,
      outcome: 'failure',
      summary: `Tried using ${PLANTED_SECRET_1} but it failed.`,
      checks: [{ name: 'auth_check', status: 'fail', reason: `token ${PLANTED_SECRET_2} was rejected` }],
    });
    expect(res.status).toBe(200);

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    const reportJson = JSON.stringify(row.report);
    expect(reportJson).not.toContain(PLANTED_SECRET_1);
    expect(reportJson).not.toContain(PLANTED_SECRET_2);
    expect(reportJson).toContain('[REDACTED]');

    const checks = await db.db.select().from(schema.runChecks).where(eq(schema.runChecks.runId, runId));
    expect(checks).toHaveLength(1);
    expect(checks[0].reason).not.toContain(PLANTED_SECRET_2);
    expect(checks[0].reason).toContain('[REDACTED]');

    await waitFor(() => mock.commentsFor(ticketKey).length > 0);
    const commentText = JSON.stringify(mock.commentsFor(ticketKey));
    expect(commentText).not.toContain(PLANTED_SECRET_1);
    expect(commentText).not.toContain(PLANTED_SECRET_2);
  });

  // Feature 019 (research D7): artifact strings are agent-authored free text
  // and now pass the scrubber too — BOTH the legacy flat form and repos[].
  it('planted secrets in artifacts (flat AND repos[]) are scrubbed before persistence and Jira', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await post(runId, 'complete', token, {
      schema_version: 2,
      outcome: 'success',
      summary: 'Done.',
      checks: [],
      artifacts: {
        branch: `feat/x-${PLANTED_SECRET_1}`,
        commits: [`abc used ${PLANTED_SECRET_2}`],
        repos: [
          {
            repo: 'lib',
            branch: `feat/y-${PLANTED_SECRET_1}`,
            pr_url: `https://git/pr?token=${PLANTED_SECRET_2}`,
            commits: [`def leaked ${PLANTED_SECRET_1}`],
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    const reportJson = JSON.stringify(row.report);
    expect(reportJson).not.toContain(PLANTED_SECRET_1);
    expect(reportJson).not.toContain(PLANTED_SECRET_2);
    expect(reportJson).toContain('[REDACTED]');

    await waitFor(() => mock.commentsFor(ticketKey).length > 0);
    const commentText = JSON.stringify(mock.commentsFor(ticketKey));
    expect(commentText).not.toContain(PLANTED_SECRET_1);
    expect(commentText).not.toContain(PLANTED_SECRET_2);
  });

  it('a blocking request_human with a planted secret in details is scrubbed in the task row and the Jira comment', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun();
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await post(runId, 'human', token, {
      kind: 'blocker',
      title: 'Need a credential',
      details: `use ${PLANTED_SECRET_1} to authenticate`,
      blocking: true,
    });
    expect(res.status).toBe(200);

    const [task] = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId)).limit(1);
    expect(task.details).not.toContain(PLANTED_SECRET_1);
    expect(task.details).toContain('[REDACTED]');

    await waitFor(() => mock.commentsFor(ticketKey).length > 0);
    const commentText = JSON.stringify(mock.commentsFor(ticketKey));
    expect(commentText).not.toContain(PLANTED_SECRET_1);
    expect(commentText).toContain('REDACTED');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const JWT_SECRET = 'callback-pr-review-test-jwt-secret';

/**
 * T112 (US4, FR-025, SC-008) — a successful run under a pull_request-delivery
 * agent whose report declares a PR queues exactly one non-blocking review
 * task; no PR / non-PR-delivery agents produce none; the orchestrator never
 * merges (no extra Jira transition beyond the normal success transition).
 */
describe('PR-review task on successful PR delivery (T112)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let backendUrl: string;
  let nextTicket = 900;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    const backendModule: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();
  }, 240_000);

  afterAll(async () => {
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function seedRunningRun(behavior: Record<string, unknown>): Promise<{ runId: string; workspaceId: string; ticketKey: string }> {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, { executorType: 'mock', ticketKey, behavior });
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

  async function complete(runId: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${backendUrl}/api/callbacks/runs/${runId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('pull_request-delivery agent + success + pr_url → exactly one non-blocking review task, run stays succeeded', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun({ code_delivery: 'pull_request' });
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await complete(runId, token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'Implemented and opened a PR.',
      checks: [],
      artifacts: { pr_url: 'https://github.com/acme/repo/pull/42' },
    });
    expect(res.status).toBe(200);

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(row.status).toBe('succeeded');

    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'review', blocking: false });
    expect(tasks[0].details).toContain('https://github.com/acme/repo/pull/42');
  });

  it('pull_request-delivery agent + success but NO pr_url → no review task', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun({ code_delivery: 'pull_request' });
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await complete(runId, token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'Implemented, no PR declared.',
      checks: [],
    });
    expect(res.status).toBe(200);

    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(tasks).toHaveLength(0);
  });

  it('a non-PR-delivery agent with a pr_url in artifacts still gets no review task', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun({}); // no code_delivery declared
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await complete(runId, token, {
      schema_version: 1,
      outcome: 'success',
      summary: 'Implemented directly on main.',
      checks: [],
      artifacts: { pr_url: 'https://github.com/acme/repo/pull/99' },
    });
    expect(res.status).toBe(200);

    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(tasks).toHaveLength(0);
  });

  // Feature 019 (research D6): a multi-repo run with several PRs still queues
  // ONE review task — a single review gate per run, listing every repo's PR.
  it('multiple repos[] PRs → one review task listing every <repo>: <url> line', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun({ code_delivery: 'pull_request' });
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await complete(runId, token, {
      schema_version: 2,
      outcome: 'success',
      summary: 'Coupled change across lib and consumer.',
      checks: [],
      artifacts: {
        repos: [
          { repo: 'lib', branch: 'feat/X', pr_url: 'https://github.com/acme/lib/pull/1' },
          { repo: 'consumer', branch: 'feat/X', pr_url: 'https://github.com/acme/consumer/pull/2' },
          { repo: 'docs', branch: 'feat/X' }, // changed but no PR — not a review line
        ],
      },
    });
    expect(res.status).toBe(200);

    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'review', blocking: false });
    expect(tasks[0].title).toBe('Review PRs (2)');
    expect(tasks[0].details).toContain('- lib: https://github.com/acme/lib/pull/1');
    expect(tasks[0].details).toContain('- consumer: https://github.com/acme/consumer/pull/2');
    expect(tasks[0].details).not.toContain('docs');
  });

  it('a single repos[] PR keeps the pre-019 title byte-for-byte (US2)', async () => {
    const { runId, workspaceId, ticketKey } = await seedRunningRun({ code_delivery: 'pull_request' });
    const token = tokenFor(runId, workspaceId, ticketKey);

    const res = await complete(runId, token, {
      schema_version: 2,
      outcome: 'success',
      summary: 'One repo changed.',
      checks: [],
      artifacts: { repos: [{ repo: 'lib', pr_url: 'https://github.com/acme/lib/pull/7' }] },
    });
    expect(res.status).toBe(200);

    const tasks = await db.db.select().from(schema.humanTasks).where(eq(schema.humanTasks.runId, runId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Review PR: https://github.com/acme/lib/pull/7');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  setFakeClaudeCallbacks,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const BASE = 'https://mock.atlassian.net';
const JWT_SECRET = 'callback-resume-e2e-test-jwt-secret';
const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_human'];

/**
 * T108 (US2, required E2E — FR-012/013/016/017/018; SC-003). The full loop:
 * attempt#1 blocking request_human then exits → parked + queued human task
 * + ticket blocked-with-comment. Resolve via the API with action=resume →
 * old run superseded, exactly one new active attempt, ticket running.
 * Attempt#2 reads the human's answer from its context and completes.
 */
describe('callback blocking escalation → resume → completion (T108)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let backendUrl: string;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();
    process.env.BRIGADIR_CALLBACK_BASE_URL = `${backendUrl}/api/callbacks`;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function pollRun(
    runId: string,
    until: (status: string) => boolean,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && until(row.status)) return row;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} stuck at ${row?.status} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function activeRuns(ticketId: string, agentId: string): Promise<Array<typeof schema.runs.$inferSelect>> {
    return db.db
      .select()
      .from(schema.runs)
      .where(
        and(eq(schema.runs.ticketId, ticketId), eq(schema.runs.agentId, agentId), inArray(schema.runs.status, ACTIVE_STATUSES)),
      );
  }

  const TERMINAL = (s: string): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(s);

  it('blocking escalation parks, resolve(resume) supersedes + creates one new attempt, attempt#2 completes', async () => {
    const ticketKey = 'BRIG-500';
    mock.seedIssue(ticketKey, { status: 'In Progress' });

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'], branch_prefix: 'feat' },
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      statusRunning: 'In Progress',
    });

    // --- attempt #1: blocking request_human, then the process exits (legitimate exit) ---
    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'human',
        body: {
          kind: 'question',
          title: 'Which auth flow?',
          details: 'OAuth or API token?',
          blocking: true,
        },
      },
    ]);

    const first = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (first.deduplicated) throw new Error('unexpected dedup');

    const parkedRun = await pollRun(first.runId, TERMINAL);
    expect(parkedRun.status).toBe('awaiting_human');

    const openTasks = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, first.runId), eq(schema.humanTasks.status, 'open')));
    expect(openTasks).toHaveLength(1);
    expect(openTasks[0]).toMatchObject({ blocking: true, kind: 'question', title: 'Which auth flow?' });

    expect(mock.transitionsFor(ticketKey)).toContain('Blocked');
    const comments = mock.commentsFor(ticketKey);
    expect(comments.length).toBeGreaterThan(0);
    const commentText = JSON.stringify(comments[comments.length - 1]);
    expect(commentText).toContain('Which auth flow?');

    // runs_one_active holds: exactly the parked run is "active" right now.
    expect(await activeRuns(p.ticketId, p.agentId)).toHaveLength(1);

    // --- resolve via the API: action=resume ---
    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: {
          schema_version: 1,
          outcome: 'success',
          summary: 'Resolved using the human answer.',
          checks: [{ name: 'tests_pass', status: 'pass' }],
        },
      },
    ]);

    const resolveRes = await fetch(`${backendUrl}/api/human-tasks/${openTasks[0].id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', answer: 'Use API token auth.', resolved_by: 'op@team' }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as { ok: boolean; action: string; newRunId: string };
    expect(resolveBody).toMatchObject({ ok: true, action: 'resume' });
    const newRunId = resolveBody.newRunId;
    expect(newRunId).not.toBe(first.runId);

    const [oldRunAfter] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, first.runId)).limit(1);
    expect(oldRunAfter.status).toBe('superseded');

    const [newRunRow] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, newRunId)).limit(1);
    expect(newRunRow.attempt).toBe(2);
    expect(newRunRow.triggerEvent).toMatchObject({ source: 'human-resume', resolution: 'Use API token auth.' });

    // runs_one_active holds throughout: at most the new attempt is active —
    // it may already have raced to a terminal state in this fast fake-CLI
    // environment, which is fine (0 active); it must never be 2+ (the old
    // and new run both counted active would be the actual guarantee break).
    const active = await activeRuns(p.ticketId, p.agentId);
    expect(active.length).toBeLessThanOrEqual(1);
    if (active.length === 1) {
      expect(active[0].id).toBe(newRunId);
    }

    expect(mock.transitionsFor(ticketKey)).toContain('In Progress');

    // --- attempt #2: reads the answer from context, completes ---
    const finalRun = await pollRun(newRunId, TERMINAL);
    expect(finalRun.status).toBe('succeeded');
    expect(finalRun.report).toMatchObject({ outcome: 'success' });
  }, 60_000);
});

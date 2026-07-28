import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
const JWT_SECRET = 'callback-noclobber-test-jwt-secret';

/**
 * T109 (US2, D7 no-clobber, FR-010 vs FR-012 seam): failIfStillRunning
 * guards `WHERE status='running'` ONLY — a legitimate `awaiting_human` park
 * must never be flipped to `failed` by the fail-closed path, contrasted
 * with a genuinely silent run (calls nothing) which DOES fail closed.
 */
describe('D7 no-clobber: awaiting_human vs silent-exit fail-closed (T109)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let backendUrl: string;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 600;

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

  async function seedAndTrigger(
    callbacks?: Array<
      | { tool: 'progress' | 'human' | 'complete'; body: Record<string, unknown> }
      | { tool: 'sleep'; ms: number }
      | { tool: 'stream'; fixture: string }
    >,
    configExtra: Record<string, unknown> = {},
  ): Promise<{ runId: string; ticketKey: string }> {
    resetFakeClaudeEnv();
    if (callbacks) setFakeClaudeCallbacks(callbacks as never);

    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress' });

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, ...configExtra }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'], branch_prefix: 'feat' },
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return { runId: res.runId, ticketKey };
  }

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

  const TERMINAL = (s: string): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(s);

  it('blocking request_human then a legitimate exit: stays awaiting_human, never flipped to failed', async () => {
    const { runId } = await seedAndTrigger([
      {
        tool: 'human',
        body: { kind: 'blocker', title: 'Missing credentials', details: 'Need the staging API key.', blocking: true },
      },
    ]);

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('awaiting_human');
    expect(row.error).toBeNull();

    // Give the fail-closed path a further beat to (incorrectly) fire, then
    // re-confirm the status held — the no-op guard, not a lucky timing win.
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(after.status).toBe('awaiting_human');
  });

  it('regression: a parked run whose process LINGERS past the cancel poll is not clobbered to cancelled', async () => {
    // Reproduces the race found at the iteration-4 checkpoint: the cancel-poll
    // sees the parked run as "no longer running" → aborts the lingering
    // process → the executor resolves 'cancelled' → without the
    // finalizeStatusIfRunning guard, the finalize branch flipped
    // awaiting_human → cancelled. cancelPollMs=100 + a 3s linger make the
    // poll fire deterministically before the process ends.
    const { runId } = await seedAndTrigger(
      [
        {
          tool: 'human',
          body: { kind: 'blocker', title: 'Which region?', details: 'eu-west or us-east?', blocking: true },
        },
        { tool: 'sleep', ms: 3000 },
      ],
      { cancelPollMs: 100 },
    );

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('awaiting_human');

    // Wait long enough for the abort → group-kill → finalize path to have run
    // its course, then confirm the park held and no cancel overwrote it.
    await new Promise((r) => setTimeout(r, 1500));
    const [after] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(after.status).toBe('awaiting_human');
    const tasks = await db.db
      .select()
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.runId, runId));
    expect(tasks.filter((t) => t.status === 'open')).toHaveLength(1);
  });

  it('contrast: a run that calls nothing at all IS flipped to failed (fail-closed holds)', async () => {
    const { runId } = await seedAndTrigger(undefined);

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();
  });

  // SXF-1174 Problem 7 (defense-in-depth): if a blocking task is open but its
  // park was missed (the incident's dedup swallow — seeded here directly as
  // the anomaly state), the exit must promote the run to awaiting_human
  // instead of fail-closing it: the pending human question survives.
  it('promotion: an exited run with an open blocking task but a missed park ends awaiting_human, not failed', async () => {
    const { runId } = await seedAndTrigger([
      { tool: 'sleep', ms: 2500 },
      // A terminal result event (no structured output) so the exit takes the
      // 'completed' fail-closed branch — the one the promotion guards.
      { tool: 'stream', fixture: 'stream-no-report' },
    ]);

    // While the fake CLI lingers, seed the anomaly: an open BLOCKING task with
    // the run still 'running' (no park).
    await pollRun(runId, (s) => s === 'running');
    const [running] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    await db.db.insert(schema.humanTasks).values({
      workspaceId: running.workspaceId,
      runId,
      ticketId: running.ticketId,
      kind: 'blocker',
      title: 'Question whose park was missed',
      details: 'anomaly seeded directly — task open, run still running',
      blocking: true,
      status: 'open',
    });

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('awaiting_human');
    expect(row.error).toBeNull();
  });

  // SXF-1174 Problem 7: the fail-closed error must name what actually
  // happened. The old executor-side "no schema-valid structured_output"
  // diagnostic was structurally guaranteed for callback-wired runs (no
  // --json-schema) and shadowed this message — the incident's red herring.
  it('fail-closed diagnostic names the missing callback, not structured_output', async () => {
    const { runId } = await seedAndTrigger([{ tool: 'stream', fixture: 'stream-no-report' }]);

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('claude_cli exited without a complete_task or request_human callback');
  });
});

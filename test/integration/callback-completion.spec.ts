import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { signRunToken } from '@brigadir/contracts';
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
  type FakeClaudeCallbackStep,
} from './claude-cli-harness';

const BASE = 'https://mock.atlassian.net';
const JWT_SECRET = 'callback-completion-test-jwt-secret';

/**
 * T104 (US1, FR-007/008/010/011; SC-001/002): the completion contract for
 * callback-wired runs — a fake CLI in callback mode (T096) drives the REAL
 * callback HTTP API served by BackendAppModule while WorkerAppModule runs
 * the actual claude_cli job, both against the same Postgres/Redis.
 */
describe('callback completion (T104)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let backendUrl: string;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 200;

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

  async function seedAndTrigger(opts: {
    fixture?: string;
    callbacks?: FakeClaudeCallbackStep[];
    executorConfigOverrides?: Record<string, unknown>;
  }): Promise<{ runId: string; ticketKey: string; workspaceId: string }> {
    resetFakeClaudeEnv();
    if (opts.fixture !== undefined) process.env.FAKE_CLAUDE_FIXTURE = opts.fixture;
    if (opts.callbacks) setFakeClaudeCallbacks(opts.callbacks);

    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress' });

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, ...opts.executorConfigOverrides }),
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
    return { runId: res.runId, ticketKey, workspaceId: p.workspaceId };
  }

  async function pollRun(
    runId: string,
    until: (row: typeof schema.runs.$inferSelect) => boolean,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && until(row)) return row;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} stuck at ${row?.status} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const TERMINAL = (row: typeof schema.runs.$inferSelect): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(row.status);

  it('success: complete_task{success} finalizes succeeded, checks persisted, ticket transitioned, 200 ACK', async () => {
    const { runId, ticketKey } = await seedAndTrigger({
      callbacks: [
        {
          tool: 'complete',
          body: {
            schema_version: 1,
            outcome: 'success',
            summary: 'Implemented via callback.',
            checks: [{ name: 'tests_pass', status: 'pass' }],
          },
        },
      ],
    });

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('succeeded');
    expect(row.report).toMatchObject({ outcome: 'success' });

    const checks = await db.db.select().from(schema.runChecks).where(eq(schema.runChecks.runId, runId));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'tests_pass', status: 'pass' });

    // ticket transitioned to the agent's success status ("Code Review", seedPipeline default)
    expect(mock.transitionsFor(ticketKey)).toContain('Code Review');
  });

  it('fail-closed: a run that calls nothing finalizes failed, and report-shaped stdout never rescues it (FR-010/011)', async () => {
    // Streams a schema-VALID structured_output in its terminal result event
    // (the same fixture the non-callback success test uses) but makes NO
    // callbacks at all — proving the callback-wired run ignores it entirely.
    const { runId } = await seedAndTrigger({ fixture: 'stream-success' });

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('failed');
    expect(row.report).toBeNull();
    expect(row.error).toBeTruthy();
    // Cost/usage from the terminal event still land (recordCostUsage runs
    // before the fail-closed status flip, so no extra polling is needed).
    expect(Number(row.costUsd)).toBeCloseTo(0.0123, 4);
    expect(row.usage).toMatchObject({ input_tokens: 1200, output_tokens: 340 });
  });

  it('cost: a callback-finalized run still gets cost_usd/usage from the terminal event after process exit', async () => {
    // The fake CLI streams the fixture BEFORE playing callbacks, whereas the
    // real CLI emits its result event last — irrelevant here: the executor
    // only reads `terminal` at process close, and the processor persists
    // cost only after run() settles. The sequence under test is: complete
    // callback finalizes the run to succeeded, the process then exits, and
    // the terminal event's total_cost_usd/usage must STILL be persisted
    // (status-independent write) without clobbering the callback's finalize.
    const { runId } = await seedAndTrigger({
      fixture: 'stream-success',
      callbacks: [
        {
          tool: 'complete',
          body: {
            schema_version: 1,
            outcome: 'success',
            summary: 'Finalized via callback, cost arrives later.',
            checks: [],
          },
        },
      ],
    });

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('succeeded');
    // The callback's report owns the finalize — not the streamed structured_output.
    expect(row.report).toMatchObject({ summary: 'Finalized via callback, cost arrives later.' });

    // Cost lands only after the process exits, which post-dates the callback
    // finalize — poll for it separately.
    const withCost = await pollRun(runId, (r) => r.costUsd !== null);
    expect(Number(withCost.costUsd)).toBeCloseTo(0.0123, 4);
    expect(withCost.usage).toMatchObject({ input_tokens: 1200, output_tokens: 340 });
    // No-clobber: the status the callback wrote survives the cost write.
    expect(withCost.status).toBe('succeeded');
    expect(withCost.report).toMatchObject({ outcome: 'success' });
  });

  it('cost: post-finalize grace lets the CLI emit its result event AFTER complete_task (production ordering)', async () => {
    // The real CLI prints its terminal result event seconds AFTER the agent's
    // complete_task callback lands (the model still finishes its turn). The
    // cancel-poll (cancelPollMs=200 here) sees the run leave 'running' almost
    // immediately — without the post-finalize grace it would SIGTERM the
    // process during the sleep below, the result event would never exist, and
    // cost_usd/usage would be unrecoverable (the live-run regression of
    // 2026-07-15). The sleep(1000) >> cancelPollMs makes that race
    // deterministic in the old code.
    const { runId } = await seedAndTrigger({
      callbacks: [
        {
          tool: 'complete',
          body: {
            schema_version: 1,
            outcome: 'success',
            summary: 'Callback first, result event later.',
            checks: [],
          },
        },
        { tool: 'sleep', ms: 1000 },
        { tool: 'stream', fixture: 'stream-success' },
      ],
    });

    const row = await pollRun(runId, TERMINAL);
    expect(row.status).toBe('succeeded');

    const withCost = await pollRun(runId, (r) => r.costUsd !== null);
    expect(Number(withCost.costUsd)).toBeCloseTo(0.0123, 4);
    expect(withCost.usage).toMatchObject({ input_tokens: 1200, output_tokens: 340 });
    expect(withCost.status).toBe('succeeded');
  });

  it('invalid report: complete_task{needs_human} with no human_task → 422 with zod errors[], run NOT finalized', async () => {
    // Drives the callback API directly with a manually-minted token so the
    // assertion is race-free against the fake CLI process's own exit timing
    // (quickstart.md pattern 1 — hitting the real API is the primary shape;
    // this is the same call the fake CLI itself would make).
    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress' });

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true }),
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });

    const [runRow] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'claude_cli',
        status: 'running',
        attempt: 1,
      })
      .returning({ id: schema.runs.id });

    const token = signRunToken(
      { sub: runRow.id, wsp: p.workspaceId, tkt: ticketKey, exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );

    const res = await fetch(`${backendUrl}/api/callbacks/runs/${runRow.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ schema_version: 1, outcome: 'needs_human', summary: 'stuck', checks: [] }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: unknown[] };
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runRow.id)).limit(1);
    expect(row.status).toBe('running');
    expect(row.report).toBeNull();
  });
});

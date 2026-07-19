import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  setFakeClaudeCallbacks,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const JWT_SECRET = 'completion-gate-test-jwt-secret';

/**
 * Feature 024 (US3) — the completion gate for unreported work.
 *
 * ⚠️ AUTHORED WITHOUT A LOCAL DOCKER RUN. This suite needs testcontainers
 * (Postgres + Redis); Docker was unavailable in the authoring session, so it
 * was written from the harness pattern but executed only on the operator's
 * stand (iteration-29 precedent). Do NOT treat a green unit run as coverage of
 * this file.
 *
 * The chain: the executor records a per-repo start SHA at prepare time; the
 * tool server (here, the fake CLI standing in for CLI+mcp-server) observes each
 * worktree's HEAD on complete_task and sends it in x-brigadir-observed-heads;
 * the backend rejects a completion that omits a repo whose HEAD moved. A
 * corrected report is then accepted.
 */
describe('claude_cli completion gate for unreported work (feature 024)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 900;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    process.env.BRIGADIR_CALLBACK_BASE_URL = `${await backend.getUrl()}/api/callbacks`;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function pollRun(runId: string, timeoutMs = 30_000): Promise<typeof schema.runs.$inferSelect> {
    const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && terminal.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function violationEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === 'handoff-violation');
  }

  function seed(ticketKey: string) {
    return seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, keepFailedWorktrees: true }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] },
      ticketKey,
      maxAttempts: 1,
    });
  }

  it('rejects a completion that omits a repo whose HEAD moved, then accepts the corrected report', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seed(ticketKey);

    resetFakeClaudeEnv();
    // The agent commits in `product` (HEAD moves) but first tries to complete
    // with NO artifact entry for it → rejected; then reports the branch and
    // completes again → accepted.
    setFakeClaudeCallbacks([
      { tool: 'commit', repo: 'product', file: 'agent.txt' },
      { tool: 'complete', body: { schema_version: 2, outcome: 'success', summary: 'forgot to report', checks: [] } },
      {
        tool: 'complete',
        body: {
          schema_version: 2,
          outcome: 'success',
          summary: 'now reporting the branch',
          checks: [],
          artifacts: { repos: [{ repo: 'product', branch: `run/${ticketKey}` }] },
        },
      },
    ]);

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId);
    // The corrected (second) completion wins — the run succeeds.
    expect(row.status).toBe('succeeded');
    // The first, dishonest completion left a durable violation breadcrumb.
    const violations = await violationEvents(res.runId);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect((violations[0].violations as Array<{ repo: string }>)[0].repo).toBe('product');
  });

  it('accepts a read-only stage that moved no HEAD and reported no artifacts', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seed(ticketKey);

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      { tool: 'complete', body: { schema_version: 1, outcome: 'success', summary: 'reviewed only', checks: [] } },
    ]);

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId);
    expect(row.status).toBe('succeeded');
    expect(await violationEvents(res.runId)).toHaveLength(0);
  });

  it('accepts when the moved repo IS reported (the honest happy path)', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seed(ticketKey);

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      { tool: 'commit', repo: 'product', file: 'agent.txt' },
      {
        tool: 'complete',
        body: {
          schema_version: 2,
          outcome: 'success',
          summary: 'implemented and reported',
          checks: [],
          artifacts: { repos: [{ repo: 'product', branch: `run/${ticketKey}` }] },
        },
      },
    ]);

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId);
    expect(row.status).toBe('succeeded');
    expect(await violationEvents(res.runId)).toHaveLength(0);

    // Sanity: the agent's commit really moved HEAD off the recorded start SHA.
    const worktree = join(row.worktreePath!, 'product');
    expect(await readFile(join(worktree, 'agent.txt'), 'utf8')).toContain('agent work');
  });
});

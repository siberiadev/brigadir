import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

/**
 * T084 (US1/MVP): a full run against the fake CLI finalizes exactly the way
 * mock's finalization path already works — success/invalid-report/no-report
 * — without fabrication, worktree created and removed.
 *
 * T087 (US4) extends this same file (below) with timeline/cost/usage/stderr
 * assertions, per tasks.md's same-spec-file grouping.
 */
describe('claude_cli lifecycle (T084/US1, T087/US4)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 100;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function triggerRun(
    fixture: string | undefined,
    opts: {
      executorConfig?: Record<string, unknown>;
      stderrText?: string;
      exitCode?: number;
      maxAttempts?: number;
    } = {},
  ): Promise<{ runId: string; ticketKey: string }> {
    resetFakeClaudeEnv();
    if (fixture !== undefined) process.env.FAKE_CLAUDE_FIXTURE = fixture;
    if (opts.stderrText !== undefined) process.env.FAKE_CLAUDE_STDERR_TEXT = opts.stderrText;
    if (opts.exitCode !== undefined) process.env.FAKE_CLAUDE_EXIT_CODE = String(opts.exitCode);

    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, opts.executorConfig),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'], branch_prefix: 'feat' },
      ticketKey,
      maxAttempts: opts.maxAttempts,
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

  it('success: finalizes succeeded, report persisted, worktree created then removed', async () => {
    const { runId } = await triggerRun('stream-success');
    const row = await pollRun(runId, TERMINAL);

    expect(row.status).toBe('succeeded');
    expect(row.report).toMatchObject({ outcome: 'success' });
    expect(row.worktreePath).toBeTruthy();
    expect(existsSync(row.worktreePath!)).toBe(false);
  });

  it('invalid report: finalizes failed with a validation diagnostic, report stays null', async () => {
    const { runId } = await triggerRun('stream-invalid-report');
    const row = await pollRun(runId, TERMINAL);

    expect(row.status).toBe('failed');
    expect(row.report).toBeNull();
    expect(row.error).toBeTruthy();
  });

  it('no report: finalizes failed with a diagnostic', async () => {
    const { runId } = await triggerRun('stream-no-report');
    const row = await pollRun(runId, TERMINAL);

    expect(row.status).toBe('failed');
    expect(row.report).toBeNull();
    expect(row.error).toBeTruthy();
  });

  // --- T087 (US4): live progress/cost visibility, extending the same file ---

  it('success: run_events timeline is ordered (log → tool_call → progress) and cost/usage match the terminal result', async () => {
    const { runId } = await triggerRun('stream-success');
    await pollRun(runId, TERMINAL);

    const events = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.id);

    const types = events.map((e) => e.type);
    expect(types.indexOf('log')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('tool_call')).toBeGreaterThan(types.indexOf('log'));
    expect(types.indexOf('progress')).toBeGreaterThan(types.indexOf('log'));
    // the terminal `result` event itself is never persisted as a timeline row.
    expect(types).not.toContain('result');

    const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(Number(row.costUsd)).toBeCloseTo(0.0123, 4);
    expect(row.usage).toMatchObject({ input_tokens: 1200, output_tokens: 340 });
  });

  // Token-spend problem 1: a bash-guard denial (user tool_result carrying the
  // [brigadir-bash-guard] prefix) lands in run_events as `tool_denied` —
  // proves the parser → persistRunEvent → DB path end-to-end.
  it('bash-guard denial: the denied Bash call is persisted as a tool_denied run_event', async () => {
    const { runId } = await triggerRun('stream-bash-guard-denied');
    await pollRun(runId, TERMINAL);

    const events = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.id);

    const denied = events.find((e) => e.type === 'tool_denied');
    expect(denied).toBeDefined();
    expect(denied!.payload).toMatchObject({ name: 'Bash', command: 'sleep 600' });
    expect(String((denied!.payload as Record<string, unknown>).reason)).toContain(
      '[brigadir-bash-guard]',
    );
    // The attempted call itself is still a normal tool_call row before it.
    const toolCallIdx = events.findIndex((e) => e.type === 'tool_call');
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(denied!)).toBeGreaterThan(toolCallIdx);
  });

  it('stderr tail: a nonzero exit with stderr output records a bounded tail in `error`', async () => {
    // No fixture set at all → fake-claude.mjs skips stdout streaming entirely
    // and goes straight to writing stderr + exiting nonzero.
    const { runId } = await triggerRun(undefined, {
      stderrText: 'fatal: simulated crash for the stderr-tail test\n',
      exitCode: 1,
      maxAttempts: 1,
    });
    const row = await pollRun(runId, (s) => s === 'failed', 30_000);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('simulated crash for the stderr-tail test');
  });
});

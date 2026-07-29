import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import type { VerificationReceipt } from '@brigadir/contracts';
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

const execFileAsync = promisify(execFile);
const JWT_SECRET = 'verification-receipt-test-jwt-secret';

/**
 * Feature 033 — ticket-level verification receipts (token-spend problem 2).
 *
 * The chain: a completing run's measured observed heads + its report's `pass`
 * checks become a sha-anchored receipt on the ticket; the NEXT run on the same
 * ticket gets the receipt injected into its wrapper iff every prepared repo
 * sits exactly at the recorded sha; any divergence surfaces as a
 * `receipt-stale` event instead. Evidence-less finalization (fail-closed, no
 * callbacks) writes nothing.
 */
describe('claude_cli ticket verification receipts (feature 033)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 950;

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

  async function eventsBySource(runId: string, source: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === source);
  }

  async function ticketVerification(ticketId: string): Promise<VerificationReceipt | null> {
    const [row] = await db.db
      .select({ verification: schema.tickets.verification })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);
    return (row?.verification as VerificationReceipt | null) ?? null;
  }

  async function originSha(ref: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', env.remoteDir, 'rev-parse', ref]);
    return stdout.trim();
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

  async function runOnce(p: { ticketId: string; agentId: string }): Promise<string> {
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  it('run 1 writes a sha-anchored receipt; run 2 at the same commit gets the verified-gates section', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const branch = `run/${ticketKey}`;
    const p = await seed(ticketKey);

    // --- Run 1 (developer): commit + push, complete with pass checks. ---
    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      { tool: 'commit', repo: 'product', file: 'feature.txt', push: branch },
      {
        tool: 'complete',
        body: {
          schema_version: 2,
          outcome: 'success',
          summary: 'implemented',
          checks: [
            { name: 'lint', status: 'pass' },
            { name: 'typecheck', status: 'pass' },
            { name: 'e2e', status: 'skip' },
          ],
          artifacts: { repos: [{ repo: 'product', branch }] },
        },
      },
    ]);
    const run1 = await runOnce(p);
    expect((await pollRun(run1)).status).toBe('succeeded');

    const receipt = await ticketVerification(p.ticketId);
    expect(receipt).not.toBeNull();
    expect(receipt!.runId).toBe(run1);
    expect(receipt!.gates).toEqual(['lint', 'typecheck']);
    // The recorded sha is the branch tip the run pushed — exactly where the
    // next stage's worktree will be prepared.
    expect(receipt!.repos).toEqual({ product: await originSha(branch) });
    expect(await eventsBySource(run1, 'verification-receipt')).toHaveLength(1);

    // --- Run 2 (read-only QA): same ticket, continues the branch. ---
    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: {
          schema_version: 1,
          outcome: 'success',
          summary: 'verified the QA scenarios only',
          checks: [{ name: 'qa scenarios', status: 'pass' }],
        },
      },
    ]);
    const run2 = await runOnce(p);
    const row2 = await pollRun(run2);
    expect(row2.status).toBe('succeeded');

    const injected = await eventsBySource(run2, 'receipt-injected');
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ receiptRunId: run1, gates: ['lint', 'typecheck'] });

    expect(row2.worktreePath).toBeTruthy();
    const wrapperText = await readFile(join(row2.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapperText).toContain('## Already verified at this exact state');
    expect(wrapperText).toContain('- lint');
    expect(wrapperText).toContain('- typecheck');
    expect(wrapperText).toContain('Do NOT re-run these checks on the unchanged code');

    // Whole-replace: run 2's own completion re-anchors the receipt to itself
    // (same sha — it committed nothing).
    const receipt2 = await ticketVerification(p.ticketId);
    expect(receipt2!.runId).toBe(run2);
    expect(receipt2!.gates).toEqual(['qa scenarios']);
    expect(receipt2!.repos).toEqual({ product: await originSha(branch) });
  }, 120_000);

  it('an out-of-band commit invalidates the receipt: no section, a receipt-stale event instead', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const branch = `run/${ticketKey}`;
    const p = await seed(ticketKey);

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      { tool: 'commit', repo: 'product', file: 'feature.txt', push: branch },
      {
        tool: 'complete',
        body: {
          schema_version: 2,
          outcome: 'success',
          summary: 'implemented',
          checks: [{ name: 'lint', status: 'pass' }],
          artifacts: { repos: [{ repo: 'product', branch }] },
        },
      },
    ]);
    const run1 = await runOnce(p);
    expect((await pollRun(run1)).status).toBe('succeeded');
    expect(await ticketVerification(p.ticketId)).not.toBeNull();

    // A human (or rework out of band) pushes another commit onto the branch —
    // the branch tip no longer matches the receipt's sha.
    await execFileAsync('git', ['-C', env.remoteDir, 'switch', branch]);
    await execFileAsync('git', ['-C', env.remoteDir, 'commit', '--allow-empty', '-m', 'out-of-band fix'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Human',
        GIT_AUTHOR_EMAIL: 'human@acme.io',
        GIT_COMMITTER_NAME: 'Human',
        GIT_COMMITTER_EMAIL: 'human@acme.io',
      },
    });
    await execFileAsync('git', ['-C', env.remoteDir, 'switch', 'main']);

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'reviewed', checks: [] },
      },
    ]);
    const run2 = await runOnce(p);
    const row2 = await pollRun(run2);
    expect(row2.status).toBe('succeeded');

    expect(await eventsBySource(run2, 'receipt-injected')).toHaveLength(0);
    const stale = await eventsBySource(run2, 'receipt-stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ receiptRunId: run1 });

    const wrapperText = await readFile(join(row2.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapperText).not.toContain('## Already verified');
  }, 120_000);

  it('a fail-closed finalization (no callbacks, no evidence) writes no receipt', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seed(ticketKey);

    resetFakeClaudeEnv();
    // The fake CLI plays no callbacks: the worker finalizes fail-closed from
    // the exit — a path that carries no observed heads.
    setFakeClaudeCallbacks([]);
    const run1 = await runOnce(p);
    expect((await pollRun(run1)).status).toBe('failed');

    expect(await ticketVerification(p.ticketId)).toBeNull();
    expect(await eventsBySource(run1, 'verification-receipt')).toHaveLength(0);
  }, 120_000);
});

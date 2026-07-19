import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);
const JWT_SECRET = 'branch-handoff-test-jwt-secret';

/**
 * Feature 023 — the pipeline stage handoff, and the ST3-780 regression.
 *
 * Before this feature the system pre-created `<branchPrefix>/<ticketKey>` per
 * run and refused to start when that branch already carried commits. Reuse was
 * granted only to `rework`/`human-resume` triggers, but a NORMAL stage handoff
 * arrives from the Jira poller — so every stage after a committing stage
 * crashed before its agent ever started:
 *
 *   repo "st3_agentic": branch "run/ST3-780" already exists with 2 commit(s)
 *   of prior work — refusing to discard or silently reuse it
 *
 * Now the branch is the agent's, and the next stage starts from the branch the
 * previous run REPORTED. The trigger source below is deliberately `poll`: that
 * is the path that always failed.
 */
describe('claude_cli branch handoff between pipeline stages (feature 023)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 780;

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

  /**
   * What a developer stage leaves behind: a branch on origin carrying its
   * commits. Done directly against the fixture remote — the fake CLI does not
   * write code, and what the next stage consumes is the pushed branch, not how
   * it got there.
   */
  async function pushDeveloperWork(branch: string, file: string): Promise<string> {
    const git = (...args: string[]) => execFileAsync('git', ['-C', env.remoteDir, ...args]);
    await git('switch', '-c', branch);
    await writeFile(join(env.remoteDir, file), 'developer work\n');
    await git('add', '-A');
    await git('-c', 'user.email=dev@acme.io', '-c', 'user.name=Dev', 'commit', '-m', 'stage 1 work');
    const { stdout } = await git('rev-parse', 'HEAD');
    await git('switch', 'main');
    return stdout.trim();
  }

  async function pollRun(
    runId: string,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && terminal.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function startRefEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === 'start-ref');
  }

  /** Seed the ticket + a completed prior stage that reported `branch` for `product`. */
  async function seedStages(opts: { ticketKey: string; reportedBranch?: string }) {
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, {
        useCallbackChannel: true,
        keepFailedWorktrees: true,
      }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] },
      ticketKey: opts.ticketKey,
      maxAttempts: 1,
    });
    if (opts.reportedBranch) {
      await db.db.insert(schema.runs).values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'claude_cli',
        status: 'succeeded',
        outcome: 'success',
        attempt: 1,
        report: {
          schema_version: 2,
          outcome: 'success',
          summary: 'Stage 1 implemented the ticket.',
          checks: [],
          artifacts: { repos: [{ repo: 'product', branch: opts.reportedBranch }] },
        },
      });
    }
    return p;
  }

  it('a poller-dispatched next stage starts from the branch the previous stage reported (ST3-780)', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const branch = `run/${ticketKey}`;
    const devSha = await pushDeveloperWork(branch, 'developer.txt');
    const p = await seedStages({ ticketKey, reportedBranch: branch });

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'Reviewed stage 1.', checks: [] },
      },
    ]);

    // `poll` — the trigger source that crashed 100% of the time before 023.
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId);
    expect(row.status).toBe('succeeded');

    // It really started at stage 1's commit, not at main.
    const worktree = join(row.worktreePath!, 'product');
    const { stdout: head } = await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD']);
    expect(head.trim()).toBe(devSha);
    expect(await readFile(join(worktree, 'developer.txt'), 'utf8')).toContain('developer work');

    // And the agent was told to build on that branch rather than cut a new one.
    const wrapperText = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapperText).toContain(`continue branch ${branch}`);

    const events = await startRefEvents(res.runId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repo: 'product',
      decision: 'report_confirmed',
      continueBranch: branch,
    });
  });

  it('with no prior work the stage starts from the default branch, recorded as such', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedStages({ ticketKey });

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'First stage.', checks: [] },
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
    expect(existsSync(join(row.worktreePath!, 'product', 'developer.txt'))).toBe(false);

    const events = await startRefEvents(res.runId);
    expect(events[0]).toMatchObject({ decision: 'default_branch', continueBranch: null });
  });

  /**
   * The asymmetry that makes the handoff safe: a branch EXPLICITLY named by a
   * report but missing from origin fails the run loudly. Falling back to the
   * default branch would let a reviewer review an empty diff and report
   * success — a false success is worse than a visible crash.
   */
  it('a reported branch that is not on origin fails the run loudly instead of starting from main', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    const p = await seedStages({ ticketKey, reportedBranch: `run/${ticketKey}-never-pushed` });

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'should never run', checks: [] },
      },
    ]);

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/repo "product".*origin has no such branch/s);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
 * Feature 035 — platform-run worktree bootstrap + dirty-guard, end to end
 * against the real worker/executor/git stack (fake CLI):
 *
 *  - a repository's `bootstrap_command` runs in the fresh worktree BEFORE the
 *    agent, with the shared npm cache exposed via `npm_config_cache`;
 *  - tracked files it dirties are reverted and the whole episode is recorded
 *    as `source:'bootstrap'` run events;
 *  - a failing bootstrap fails the run with diagnostics, before any CLI spawn.
 */
describe('claude_cli repository bootstrap (feature 035)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 700;

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

  async function triggerRun(opts: { bootstrapCommand?: string }): Promise<string> {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, {
        pmCacheRoot: join(env.root, 'pm-cache'),
      }),
      behavior: { allowed_tools: ['Read'] },
      workspaceSettings: {
        repositories: [
          {
            name: 'product',
            git_url: env.remoteDir,
            default_branch: 'main',
            ...(opts.bootstrapCommand ? { bootstrap_command: opts.bootstrapCommand } : {}),
          },
        ],
      },
      ticketKey: `BRIG-${nextTicket++}`,
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  async function pollRun(
    runId: string,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const TERMINAL = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && TERMINAL.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function bootstrapEventsFor(runId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === 'bootstrap');
  }

  it('runs the bootstrap, reverts what it dirtied, and records both events', async () => {
    const cacheProbe = join(env.root, 'bootstrap-cache-probe.txt');
    const runId = await triggerRun({
      // Dirty a tracked file, leave an untracked one, and prove the shared
      // npm cache env reached the command — all in one bootstrap.
      bootstrapCommand: `echo mutated >> README.md && touch untracked-by-bootstrap.txt && echo "$npm_config_cache" > ${cacheProbe}`,
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');

    // The command saw the platform's shared package-manager cache.
    expect((await readFile(cacheProbe, 'utf8')).trim()).toBe(join(env.root, 'pm-cache', 'npm'));

    const events = await bootstrapEventsFor(runId);
    const exec = events.find((e) => e.command !== undefined);
    expect(exec).toBeDefined();
    expect(exec).toMatchObject({ repo: 'product', exit_code: 0 });
    expect(exec?.command).toContain('echo mutated >> README.md');

    const dirty = events.find((e) => e.kind === 'dirty-after-prepare');
    expect(dirty).toBeDefined();
    expect(dirty).toMatchObject({ repo: 'product', reverted_files: ['README.md'] });
    expect(dirty?.untracked).toContain('untracked-by-bootstrap.txt');
    // The revert actually took: no residue reported for the tracked file.
    expect(dirty?.residual_modified).toBeUndefined();
  });

  it('a failing bootstrap fails the run with diagnostics naming the repo and exit code', async () => {
    const runId = await triggerRun({ bootstrapCommand: 'echo doomed >&2; exit 7' });
    const row = await pollRun(runId);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('bootstrap of "product" failed with exit code 7');
    expect(row.error).toContain('doomed');

    const events = await bootstrapEventsFor(runId);
    const exec = events.find((e) => e.command !== undefined);
    expect(exec).toMatchObject({ repo: 'product', exit_code: 7 });
  });

  it('no bootstrap_command: prepare stays byte-identical — zero bootstrap events, run succeeds', async () => {
    const runId = await triggerRun({});
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await bootstrapEventsFor(runId)).toEqual([]);
  });
});

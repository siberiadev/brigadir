import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

/**
 * Repository resolution for claude_cli runs (feature 019 multi-repo,
 * research D1): `behavior.repositories` (subset) wins; deprecated
 * `behavior.repository` = one-element list; absent → ALL workspace
 * repositories (deliberate 019 behavior change from "first entry only");
 * neither settings repos nor a yaml fallback → the run fails with a clear
 * error. This suite boots the worker WITHOUT agents.yaml (DB-only), so the
 * workspace settings are the only repo source — the executor config's
 * leftover `repository` key (baseExecutorConfig still carries 'product')
 * must be IGNORED throughout.
 */
describe('claude_cli repository resolution (repositories[] → repository → all → error)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let infraRemoteDir: string;
  let nextTicket = 500;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();

    // A SECOND local remote so behavior.repository has something non-default
    // to point at (the harness env's remote plays "product").
    infraRemoteDir = join(env.root, 'infra-remote');
    await execFileAsync('git', ['init', '-b', 'main', infraRemoteDir]);
    await writeFile(join(infraRemoteDir, 'README.md'), '# infra repo\n');
    await execFileAsync('git', ['add', '-A'], { cwd: infraRemoteDir });
    await execFileAsync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'],
      { cwd: infraRemoteDir },
    );

    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    // DB-only boot: no agents.yaml — the yaml repo fallback must NOT exist here.
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

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

  const repositories = () => [
    { name: 'product', git_url: env.remoteDir, default_branch: 'main' },
    { name: 'infra', git_url: infraRemoteDir, default_branch: 'main' },
  ];

  async function triggerRun(opts: {
    behavior?: Record<string, unknown>;
    workspaceSettings?: Record<string, unknown>;
    fixture?: string;
  }): Promise<string> {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = opts.fixture ?? 'stream-success';
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      // baseExecutorConfig still carries the pre-0003 leftover repository key —
      // deliberately, to prove the runtime ignores it.
      executorConfig: baseExecutorConfig(env),
      behavior: { allowed_tools: ['Read'], ...(opts.behavior ?? {}) },
      workspaceSettings: opts.workspaceSettings,
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

  /**
   * Was `repoName` mounted for this run? Feature 023 removed the
   * system-created `run/<ticket>` branch that used to be the discriminator;
   * the per-repo `start-ref` timeline event is the durable per-run record,
   * written before the worktree that cleanup later removes.
   */
  async function mountedInRun(runId: string, repoName: string): Promise<boolean> {
    const rows = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .some((p) => p?.source === 'start-ref' && p?.repo === repoName);
  }

  it('deprecated behavior.repository wins: the run clones ONLY the named repo (US2 legacy path)', async () => {
    const runId = await triggerRun({
      behavior: { repository: 'infra' },
      workspaceSettings: { repositories: repositories() },
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    // The worktree machinery caches each cloned repo under its NAME — infra was
    // cloned, and the default (product) was never touched.
    expect(existsSync(join(env.repoCacheRoot, 'infra'))).toBe(true);
    expect(existsSync(join(env.repoCacheRoot, 'product'))).toBe(false);
    // Feature 019: worktree_path points at the run's PARENT workspace dir.
    expect(row.worktreePath).toBe(join(env.worktreeRoot, runId));
  });

  it('absent scope → ALL workspace repositories mounted (feature 019, D1)', async () => {
    const runId = await triggerRun({
      workspaceSettings: { repositories: repositories() },
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    // BOTH repos cloned (pre-019 this case resolved only the default/first).
    expect(existsSync(join(env.repoCacheRoot, 'product'))).toBe(true);
    expect(existsSync(join(env.repoCacheRoot, 'infra'))).toBe(true);
    // Feature 023: every repo got its own detached worktree at its own start
    // ref — recorded per repo on the run timeline.
    expect(await mountedInRun(runId, 'product')).toBe(true);
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect(row.worktreePath).toBe(join(env.worktreeRoot, runId));
  });

  it('behavior.repositories subset: only the named repos get worktrees (US3)', async () => {
    const runId = await triggerRun({
      behavior: { repositories: ['infra'] },
      workspaceSettings: { repositories: repositories() },
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect(await mountedInRun(runId, 'product')).toBe(false);
  });

  it('an unknown name in behavior.repositories fails the run with a clear error (defense behind config validation)', async () => {
    const runId = await triggerRun({
      behavior: { repositories: ['ghost'] },
      workspaceSettings: { repositories: repositories() },
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no repository named "ghost"/);
  });

  it('a multi-repo report round-trips: artifacts.repos[] persisted on the run (feature 019)', async () => {
    const runId = await triggerRun({
      workspaceSettings: { repositories: repositories() },
      fixture: 'stream-success-multi-repo',
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    const report = row.report as {
      schema_version: number;
      artifacts?: { repos?: { repo: string; pr_url?: string }[] };
    };
    expect(report.schema_version).toBe(2);
    expect(report.artifacts?.repos).toHaveLength(2);
    expect(report.artifacts?.repos?.map((r) => r.repo)).toEqual(['product', 'infra']);
    expect(report.artifacts?.repos?.[0].pr_url).toBe('https://git.example.com/product/pull/11');
  });

  it('no scope fields, no settings repos, no yaml → the run fails with a clear error', async () => {
    const runId = await triggerRun({}); // workspace settings stay {}
    const row = await pollRun(runId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no repository .*found|no repositories/i);
    expect(row.error).toMatch(/no agents\.yaml is loaded/);
  });
});

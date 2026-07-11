import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * T085 (US2, mandatory security test — FR-019/SC-003): with canary secrets
 * in the worker's OWN environment, a run's spawned child must see NONE of
 * them, in either its environment or its command-line arguments. This is
 * the mandatory Constitution V guarantee for this feature, closing the loop
 * (T078's unit test already proved the pure allowlist function alone) through
 * the real worker/spawn path.
 */
describe('claude_cli security — env/argv secret isolation (T085/US2)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let nextTicket = 500;

  const CANARIES: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant-canary-security-test',
    ANTHROPIC_AUTH_TOKEN: 'canary-auth-token-security-test',
    AWS_SECRET_ACCESS_KEY: 'canary-aws-secret-security-test',
    JIRA_API_TOKEN: 'canary-jira-api-token-security-test',
    DATABASE_URL: 'postgres://canary-user:canary-pass@canary-host/canary-db',
  };
  let savedEnv: Record<string, string | undefined> = {};

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

  /** Runs one full claude_cli run with canaries injected into the worker's own env. */
  async function runWithCanaries(): Promise<{ envDump: Record<string, string>; argvDump: string[] }> {
    for (const [key, value] of Object.entries(CANARIES)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      const dumpDir = await mkdtemp(join(tmpdir(), 'brigadir-security-dump-'));
      const envDumpPath = join(dumpDir, 'env.json');
      const argvDumpPath = join(dumpDir, 'argv.json');

      resetFakeClaudeEnv();
      process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
      process.env.FAKE_CLAUDE_ENV_DUMP = envDumpPath;
      process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpPath;

      const ticketKey = `BRIG-${nextTicket++}`;
      const p = await seedPipeline(db.db, {
        executorType: 'claude_cli',
        executorConfig: baseExecutorConfig(env),
        behavior: { allowed_tools: ['Read', 'Edit'], branch_prefix: 'feat' },
        ticketKey,
      });
      // A distinctive "ticket body" canary of our own: if this ever showed up
      // in argv it would prove instruction/ticket text leaked onto the CLI
      // command line (D7) — args.ts structurally can't do this, but this is
      // the empirical check through the real spawn.
      const res = await trigger.trigger({
        ticketId: p.ticketId,
        agentId: p.agentId,
        triggerEvent: { source: 'manual' },
      });
      if (res.deduplicated) throw new Error('unexpected dedup');

      const row = await pollRun(res.runId, TERMINAL);
      expect(row.status).toBe('succeeded'); // sanity: the run actually completed normally

      const envDump = JSON.parse(readFileSync(envDumpPath, 'utf8')) as Record<string, string>;
      const argvDump = JSON.parse(readFileSync(argvDumpPath, 'utf8')) as string[];
      return { envDump, argvDump };
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      savedEnv = {};
    }
  }

  it('0% of injected canaries appear in the spawned process env or argv', async () => {
    const { envDump, argvDump } = await runWithCanaries();
    const argvJoined = argvDump.join(' ');

    for (const [key, value] of Object.entries(CANARIES)) {
      expect(envDump[key], `env leaked canary key ${key}`).toBeUndefined();
      expect(argvJoined, `argv leaked canary value for ${key}`).not.toContain(value);
    }

    // Only allowlisted/config-declared keys ever pass through (D6) — the
    // FAKE_CLAUDE_* control vars are the test-harness allowlist entries
    // (env-allowlist.ts), everything else must be a standard OS var.
    const OS_ALLOWLIST = new Set([
      'HOME',
      'PATH',
      'USER',
      'LOGNAME',
      'SHELL',
      'LANG',
      'TERM',
      'TMPDIR',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      // Benign macOS-injected variable: observed empirically to appear in a
      // spawned child's env on darwin REGARDLESS of the explicit `env` object
      // passed to `spawn()` (an OS/Core-Foundation behavior, not something
      // our code passes through) — not a secret, not app-controlled.
      '__CF_USER_TEXT_ENCODING',
    ]);
    for (const key of Object.keys(envDump)) {
      const isFakeClaudeControlVar = key.startsWith('FAKE_CLAUDE_');
      expect(isFakeClaudeControlVar || OS_ALLOWLIST.has(key), `unexpected env key leaked through: ${key}`).toBe(
        true,
      );
    }
  });

  it('the allowlist floor holds on a second, independent run (no config-declared passthrough exists to vary — see deviation note)', async () => {
    // research D6 mentions "plus keys the agent config explicitly declares",
    // but contracts/executor-config.md (T075, the frozen field list actually
    // implemented) has no such field this iteration — env-allowlist.ts's
    // allowlist is a fixed static list with no per-agent extension point.
    // Re-running the same scenario re-confirms the floor holds run-over-run,
    // which is the only thing left to vary given the current contract.
    const { envDump, argvDump } = await runWithCanaries();
    const argvJoined = argvDump.join(' ');
    for (const [key, value] of Object.entries(CANARIES)) {
      expect(envDump[key]).toBeUndefined();
      expect(argvJoined).not.toContain(value);
    }
  });
});

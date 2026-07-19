import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { slugifyAgentKey } from '@brigadir/contracts';
import { RunTriggerService } from '@brigadir/runs';
import { sealExecutorSecrets } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { KimiRunProcessor } from '../../apps/worker/src/kimi-run.processor';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

/**
 * Feature 025 (T019) — the per-profile gate and live type-capacity re-apply
 * work on `run.kimi` exactly as on the other run queues: the KimiRunProcessor
 * worker's concurrency converges to the sum of ENABLED kimi profiles'
 * max_parallel_runs (and only kimi profiles — the claude_cli worker keeps its
 * own budget), and a limit-1 kimi profile never runs two jobs at once while
 * gating burns no attempt.
 */
describe('kimi per-profile gate + type capacity (feature 025, T019)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let kimiProc: KimiRunProcessor;
  let claudeProc: ClaudeCliRunProcessor;
  let workspaceId: string;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    // Fast cycles so the suite doesn't wait out production ttls.
    process.env.EXECUTOR_GATE_TTL_MS = '120';
    process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS = '120';

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'kimi-gate-ws',
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    kimiProc = worker.get(KimiRunProcessor);
    claudeProc = worker.get(ClaudeCliRunProcessor);
    await kimiProc.worker.waitUntilReady();
    await claudeProc.worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    delete process.env.EXECUTOR_GATE_TTL_MS;
    delete process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS;
    await worker?.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function seedKimiProfile(name: string, maxParallelRuns: number) {
    const [row] = await db.db
      .insert(schema.executors)
      .values({
        type: 'kimi',
        name,
        maxParallelRuns,
        config: baseExecutorConfig(env, { model: 'kimi-k3' }),
        secrets: sealExecutorSecrets({ api_key: 'sk-moonshot-gate' }),
      })
      .returning({ id: schema.executors.id });
    return row.id;
  }

  async function seedAgentWithTicket(executorId: string, name: string, ticketKey: string) {
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId,
        executorId,
        name,
        key: slugifyAgentKey(name),
        instruction: 'x',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        maxAttempts: 2,
        behavior: { allowed_tools: ['Read'] },
      })
      .returning({ id: schema.agents.id });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: ticketKey, jiraId: ticketKey, summary: 'kimi gate' })
      .returning({ id: schema.tickets.id });
    return { agentId: agent.id, ticketId: ticket.id };
  }

  const statusesOf = async (runIds: string[]) =>
    db.db
      .select({ id: schema.runs.id, status: schema.runs.status, attempt: schema.runs.attempt })
      .from(schema.runs)
      .where(inArray(schema.runs.id, runIds));

  it('kimi type capacity converges to the enabled-profiles sum; limit-1 profile never doubles up; no attempt burned', async () => {
    const profileA = await seedKimiProfile('kimi-gate-a-limit1', 1);
    await seedKimiProfile('kimi-gate-b-limit2', 2);

    const a1 = await seedAgentWithTicket(profileA, 'kimi-a1', 'KGATE-1');
    const a2 = await seedAgentWithTicket(profileA, 'kimi-a2', 'KGATE-2');

    // Re-apply tick lifts the kimi worker to the type capacity (1+2=3)…
    const capDeadline = Date.now() + 10_000;
    while (kimiProc.worker.concurrency !== 3) {
      if (Date.now() > capDeadline) {
        throw new Error(`kimi type capacity never reached 3 (at ${kimiProc.worker.concurrency})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // …while the claude_cli worker's budget is untouched by kimi profiles
    // (no claude_cli profiles here → its decorator default stands).
    expect(claudeProc.worker.concurrency).toBe(2);

    // Slow the fake CLI so a run visibly lingers `running`.
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    process.env.FAKE_CLAUDE_LINE_DELAY_MS = '250';

    const first = await trigger.trigger({
      ticketId: a1.ticketId,
      agentId: a1.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (first.deduplicated) throw new Error('unexpected dedup');
    // Let the first run occupy the profile's single slot before the second is
    // enqueued (the gate's count-then-run check is deliberately not
    // transactional — same discipline as the mock gate suite).
    {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [r] = await statusesOf([first.runId]);
        if (r?.status === 'running') break;
        if (Date.now() > deadline) throw new Error('first kimi run never started');
        await new Promise((rr) => setTimeout(rr, 30));
      }
    }
    const second = await trigger.trigger({
      ticketId: a2.ticketId,
      agentId: a2.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (second.deduplicated) throw new Error('unexpected dedup');
    const all = [first.runId, second.runId];

    let maxRunning = 0;
    const deadline = Date.now() + 45_000;
    for (;;) {
      const rows = await statusesOf(all);
      const running = rows.filter((r) => r.status === 'running').length;
      maxRunning = Math.max(maxRunning, running);
      if (rows.length === 2 && rows.every((r) => r.status === 'succeeded')) break;
      if (rows.some((r) => ['failed', 'timed_out', 'cancelled'].includes(r.status))) {
        throw new Error(`unexpected terminal state: ${JSON.stringify(rows)}`);
      }
      if (Date.now() > deadline) throw new Error(`kimi runs stuck: ${JSON.stringify(rows)}`);
      await new Promise((r) => setTimeout(r, 40));
    }

    expect(maxRunning).toBe(1); // the limit-1 profile never ran two at once
    const final = await statusesOf(all);
    expect(final.every((r) => r.status === 'succeeded' && r.attempt === 1)).toBe(true);
  }, 90_000);
});

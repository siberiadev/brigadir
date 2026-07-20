import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { slugifyAgentKey } from '@brigadir/contracts';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';

/**
 * Per-profile max_parallel_runs gate (named runner profiles, 2026-07-14). Two
 * mock profiles with limits 1 and 2 share the run.mock queue: the limit-1
 * profile must never have more than 1 simultaneously `running` run while the
 * other profile still executes; gated jobs return to waiting WITHOUT burning
 * an attempt (all runs finish `succeeded` at attempt 1). The worker's own
 * concurrency is the TYPE capacity — the sum of ENABLED profiles — applied at
 * boot and on the ~15s re-apply tick; a disabled profile is excluded from the
 * sum and its jobs are held by the gate.
 */
describe('per-profile max_parallel_runs gate', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let trigger: RunTriggerService;
  let mockProc: RunProcessor;
  let workspaceId: string;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    // Fast cycles so the suite doesn't wait out production ttls.
    process.env.EXECUTOR_GATE_TTL_MS = '120';
    process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS = '120';

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'gate-ws',
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    mockProc = worker.get(RunProcessor);
    await mockProc.worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    delete process.env.EXECUTOR_GATE_TTL_MS;
    delete process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS;
    await worker?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function seedProfile(name: string, maxParallelRuns: number, enabled = true) {
    const [row] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name, maxParallelRuns, enabled, config: {} })
      .returning({ id: schema.executors.id });
    return row.id;
  }

  async function seedProfileWithModel(name: string, maxParallelRuns: number, model: string) {
    const [row] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name, maxParallelRuns, enabled: true, config: { model } })
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
      })
      .returning({ id: schema.agents.id });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: ticketKey, jiraId: ticketKey, summary: 'gate' })
      .returning({ id: schema.tickets.id });
    return { agentId: agent.id, ticketId: ticket.id };
  }

  async function triggerDelayRun(p: { agentId: string; ticketId: string }, delayMs: number) {
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual', mock_scenario: 'delay', mock_delay_ms: delayMs },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  const statusesOf = async (runIds: string[]) => {
    const rows = await db.db
      .select({ id: schema.runs.id, status: schema.runs.status, attempt: schema.runs.attempt })
      .from(schema.runs)
      .where(inArray(schema.runs.id, runIds));
    return rows;
  };

  it('limit-1 profile never exceeds 1 running while the limit-2 profile still executes; no attempt burned', async () => {
    const profileA = await seedProfile('gate-a-limit1', 1);
    const profileB = await seedProfile('gate-b-limit2', 2);

    const a1 = await seedAgentWithTicket(profileA, 'a1', 'GATE-1');
    const a2 = await seedAgentWithTicket(profileA, 'a2', 'GATE-2');
    const b1 = await seedAgentWithTicket(profileB, 'b1', 'GATE-3');
    const b2 = await seedAgentWithTicket(profileB, 'b2', 'GATE-4');

    // Wait for the re-apply tick to lift the worker to the type capacity (1+2=3)
    // so all four jobs COULD run at once if the per-profile gate didn't exist.
    const capDeadline = Date.now() + 10_000;
    while (mockProc.worker.concurrency !== 3) {
      if (Date.now() > capDeadline) throw new Error(`type capacity never reached 3 (at ${mockProc.worker.concurrency})`);
      await new Promise((r) => setTimeout(r, 50));
    }

    // Let A1 occupy the profile's single slot BEFORE A2 is even enqueued —
    // the gate's count-then-run check is deliberately not transactional
    // (documented in executor-gate.ts), so a simultaneous first pickup is the
    // one race this suite must not depend on.
    const runA1 = await triggerDelayRun(a1, 1500);
    {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [r] = await statusesOf([runA1]);
        if (r?.status === 'running') break;
        if (Date.now() > deadline) throw new Error('A1 never started');
        await new Promise((rr) => setTimeout(rr, 30));
      }
    }
    const runA2 = await triggerDelayRun(a2, 1500);
    const runB1 = await triggerDelayRun(b1, 800);
    const runB2 = await triggerDelayRun(b2, 800);
    const all = [runA1, runA2, runB1, runB2];
    const aRuns = [runA1, runA2];

    let maxARunning = 0;
    let sawBRunningWhileAHeld = false;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const rows = await statusesOf(all);
      const aRunning = rows.filter((r) => aRuns.includes(r.id) && r.status === 'running').length;
      const aQueued = rows.filter((r) => aRuns.includes(r.id) && r.status === 'queued').length;
      const bRunning = rows.filter((r) => !aRuns.includes(r.id) && r.status === 'running').length;
      maxARunning = Math.max(maxARunning, aRunning);
      // The gate holds A's second run while B's jobs proceed — the whole type
      // queue is NOT starved by one saturated profile.
      if (aRunning === 1 && aQueued === 1 && bRunning >= 1) sawBRunningWhileAHeld = true;
      if (rows.length === 4 && rows.every((r) => r.status === 'succeeded')) break;
      if (rows.some((r) => ['failed', 'timed_out', 'cancelled'].includes(r.status))) {
        throw new Error(`unexpected terminal state: ${JSON.stringify(rows)}`);
      }
      if (Date.now() > deadline) throw new Error(`runs stuck: ${JSON.stringify(rows)}`);
      await new Promise((r) => setTimeout(r, 40));
    }

    expect(maxARunning).toBe(1); // the limit-1 profile never doubled up
    expect(sawBRunningWhileAHeld).toBe(true); // the other profile kept executing
    // Gating consumed no attempt: every run succeeded on attempt 1.
    const final = await statusesOf(all);
    expect(final.every((r) => r.status === 'succeeded' && r.attempt === 1)).toBe(true);
  }, 60_000);

  it('a disabled profile is excluded from the type capacity and its jobs are held by the gate', async () => {
    const disabled = await seedProfile('gate-c-disabled', 5, false);
    const c1 = await seedAgentWithTicket(disabled, 'c1', 'GATE-5');

    // Capacity stays the enabled sum (3) despite the disabled profile's 5.
    await new Promise((r) => setTimeout(r, 400)); // > one re-apply tick
    expect(mockProc.worker.concurrency).toBe(3);

    const runC = await triggerDelayRun(c1, 100);
    // Held: after several gate cycles the run is still queued, attempt untouched.
    await new Promise((r) => setTimeout(r, 900));
    const [row] = await statusesOf([runC]);
    expect(row.status).toBe('queued');
    expect(row.attempt).toBe(1); // markRunning never ran — nothing consumed

    // Re-enabling the profile releases the held job.
    await db.db
      .update(schema.executors)
      .set({ enabled: true })
      .where(eq(schema.executors.id, disabled));
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [r] = await statusesOf([runC]);
      if (r.status === 'succeeded') break;
      if (Date.now() > deadline) throw new Error(`held run never released (at ${r.status})`);
      await new Promise((rr) => setTimeout(rr, 50));
    }
  }, 60_000);

  it('per-model cap holds the 3rd run across two profiles sharing a model; no attempt burned (Phase 5)', async () => {
    // Two profiles, each limit 3 (so the PROFILE cap can never bite here), both
    // running the same model with EXECUTOR_MODEL_LIMITS = 2 → the model tier
    // must cap the union at 2 concurrent and hold the 3rd without an attempt.
    const model = 'shared-model-x';
    process.env.EXECUTOR_MODEL_LIMITS = JSON.stringify({ [model]: 2 });
    try {
      const mProfileA = await seedProfileWithModel('model-a', 3, model);
      const mProfileB = await seedProfileWithModel('model-b', 3, model);
      const ma = await seedAgentWithTicket(mProfileA, 'ma', 'GATE-6');
      const mb = await seedAgentWithTicket(mProfileB, 'mb', 'GATE-7');
      const mc = await seedAgentWithTicket(mProfileA, 'mc', 'GATE-8');

      // Occupy both model slots first (distinct profiles), each long enough to
      // overlap the 3rd run's whole gate-hold window.
      const runMA = await triggerDelayRun(ma, 2000);
      const runMB = await triggerDelayRun(mb, 2000);
      const twoRunning = Date.now() + 10_000;
      for (;;) {
        const rows = await statusesOf([runMA, runMB]);
        if (rows.length === 2 && rows.every((r) => r.status === 'running')) break;
        if (Date.now() > twoRunning) throw new Error(`two model runs never both running: ${JSON.stringify(rows)}`);
        await new Promise((r) => setTimeout(r, 30));
      }

      // The 3rd is over the model cap → held (queued, attempt untouched) while
      // the first two run.
      const runMC = await triggerDelayRun(mc, 300);
      await new Promise((r) => setTimeout(r, 900));
      const [heldRow] = await statusesOf([runMC]);
      expect(heldRow.status).toBe('queued');
      expect(heldRow.attempt).toBe(1); // markRunning never ran — nothing consumed

      // Once a model slot frees, the held run completes on its first attempt.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const [r] = await statusesOf([runMC]);
        if (r.status === 'succeeded') {
          expect(r.attempt).toBe(1);
          break;
        }
        if (Date.now() > deadline) throw new Error(`model-held run never released (at ${r.status})`);
        await new Promise((rr) => setTimeout(rr, 50));
      }
    } finally {
      delete process.env.EXECUTOR_MODEL_LIMITS;
    }
  }, 60_000);
});

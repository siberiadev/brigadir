import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import {
  startDatabase,
  startRedis,
  seedPipeline,
  TEST_DASHBOARD_TOKEN,
  DbHarness,
  RedisHarness,
} from './harness';

/**
 * Feature 029: the /api/metrics/* timeline aggregates against a real Postgres.
 * Seeds runs/human-tasks across statuses, executors, days and dimensions, then
 * asserts the pre-aggregation rules: UTC bucketing (M4), zero-fill (R3),
 * median/p95 over finished runs only (FR-012/R4), the finished_at duration
 * anchor (M2), the `__unknown__` NULL bucket (FR-014), executor_type NOT applied
 * to human metrics (H1), and DashboardTokenGuard (401).
 */
describe('metrics timeline (feature 029)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let ws1: string;
  let ws2: string;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const get = (path: string) =>
    fetch(`${url}${path}`, { headers: authHeaders }).then((r) => r.json());

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [BackendAppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  type RunSeed = typeof schema.runs.$inferInsert;

  // Seeding runs INSIDE the suite, after the zero-state assertion (vitest runs
  // `it` blocks in declaration order).
  async function seedAll() {
    const p1 = await seedPipeline(db.db, { ticketKey: 'BRIG-1' });
    const p2 = await seedPipeline(db.db, { ticketKey: 'BRIG-2' });
    ws1 = p1.workspaceId;
    ws2 = p2.workspaceId;

    // Extra tickets so multiple active runs coexist without tripping runs_one_active.
    const extra = async (ws: string, key: string) =>
      (
        await db.db
          .insert(schema.tickets)
          .values({ workspaceId: ws, jiraKey: key, jiraId: key, summary: key })
          .returning({ id: schema.tickets.id })
      )[0].id;
    const t1b = await extra(ws1, 'BRIG-1B');
    const t1c = await extra(ws1, 'BRIG-1C');
    const t1d = await extra(ws1, 'BRIG-1D');

    const dur = (startH: number, seconds: number) => ({
      startedAt: hoursAgo(startH),
      finishedAt: new Date(hoursAgo(startH).getTime() + seconds * 1000),
    });

    // Token usage jsonb (feature 029 cost tab): 3×100 + 200 = 500 input total.
    const usage = (input: number) => ({
      input_tokens: input,
      output_tokens: input / 2,
      cache_read_input_tokens: input / 10,
      cache_creation_input_tokens: input / 20,
    });

    const runs: RunSeed[] = [
      // 3 succeeded (mock, ws1) with durations 10/20/30s, cost 0.10 each.
      { workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(5), ...dur(5, 10), costUsd: '0.1000', usage: usage(100) },
      { workspaceId: ws1, ticketId: t1b, agentId: p1.agentId, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(5), ...dur(5, 20), costUsd: '0.1000', usage: usage(100) },
      { workspaceId: ws1, ticketId: t1c, agentId: p1.agentId, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(5), ...dur(5, 30), costUsd: '0.1000', usage: usage(100) },
      // 1 failed (mock, ws1) duration 40s, cost 0.20.
      { workspaceId: ws1, ticketId: t1d, agentId: p1.agentId, executorType: 'mock', status: 'failed', createdAt: hoursAgo(5), ...dur(5, 40), costUsd: '0.2000', usage: usage(200) },
      // Non-terminal statuses (excluded from success_rate; unfinished don't skew median).
      { workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'queued', createdAt: hoursAgo(4) },
      { workspaceId: ws1, ticketId: t1b, agentId: p1.agentId, executorType: 'mock', status: 'awaiting_human', createdAt: hoursAgo(4), startedAt: hoursAgo(4) },
      { workspaceId: ws1, ticketId: t1c, agentId: p1.agentId, executorType: 'mock', status: 'superseded', createdAt: hoursAgo(4) },
      // 1 running kimi run in ws2 (unfinished, cost null).
      { workspaceId: ws2, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'kimi', status: 'running', createdAt: hoursAgo(3), startedAt: hoursAgo(3) },
    ];
    for (const r of runs) await db.db.insert(schema.runs).values(r);

    await db.db.insert(schema.humanTasks).values([
      { workspaceId: ws1, ticketId: p1.ticketId, kind: 'question', title: 'Q1', status: 'open', createdAt: hoursAgo(6) },
      { workspaceId: ws2, ticketId: p2.ticketId, kind: 'blocker', title: 'Q2', status: 'open', createdAt: hoursAgo(6) },
      { workspaceId: ws1, ticketId: p1.ticketId, kind: 'review', title: 'Done', status: 'resolved', createdAt: hoursAgo(7), resolvedAt: hoursAgo(6) },
    ]);
  }

  // --- US1: overview ---

  describe('GET /api/metrics/overview', () => {
    it('returns an all-zero summary on an idle platform (200, never an error)', async () => {
      const body = await get('/api/metrics/overview');
      expect(body).toEqual({
        period: '7d',
        total_cost_usd: '0',
        run_count_by_status: {
          queued: 0,
          running: 0,
          awaiting_human: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          timed_out: 0,
          superseded: 0,
        },
        success_rate: null,
        median_duration_s: null,
        open_human_tasks: 0,
      });
    });

    it('counts statuses, computes success_rate over decided runs, median over finished only', async () => {
      await seedAll();
      const body = await get('/api/metrics/overview');
      expect(body.run_count_by_status).toEqual({
        queued: 1,
        running: 1,
        awaiting_human: 1,
        succeeded: 3,
        failed: 1,
        cancelled: 0,
        timed_out: 0,
        superseded: 1,
      });
      // decided = 3 succeeded + 1 failed → 3/4.
      expect(body.success_rate).toBeCloseTo(0.75, 5);
      // durations 10/20/30/40 → median 25; the unfinished runs never skew it.
      expect(body.median_duration_s).toBeCloseTo(25, 5);
      expect(Number(body.total_cost_usd)).toBeCloseTo(0.5, 4);
      expect(typeof body.total_cost_usd).toBe('string');
      expect(body.open_human_tasks).toBe(2);
    });

    it('applies executor_type to runs but NOT to open_human_tasks (H1/FR-011a)', async () => {
      const body = await get('/api/metrics/overview?executor_type=kimi');
      // Only the running kimi run matches the run filter.
      expect(body.run_count_by_status.running).toBe(1);
      expect(body.run_count_by_status.succeeded).toBe(0);
      expect(body.success_rate).toBeNull(); // nothing decided
      expect(body.median_duration_s).toBeNull(); // nothing finished
      // open_human_tasks ignores executor_type entirely.
      expect(body.open_human_tasks).toBe(2);
    });

    it('scopes runs and human tasks by workspace_id', async () => {
      const body = await get(`/api/metrics/overview?workspace_id=${ws2}`);
      expect(body.run_count_by_status.running).toBe(1);
      expect(body.run_count_by_status.succeeded).toBe(0);
      expect(body.open_human_tasks).toBe(1);
    });

    it('returns an empty (200) summary for an invalid workspace_id (M8)', async () => {
      const body = await get('/api/metrics/overview?workspace_id=not-a-uuid');
      expect(body.run_count_by_status.succeeded).toBe(0);
      expect(body.open_human_tasks).toBe(0);
      expect(body.total_cost_usd).toBe('0');
    });

    it('requires the dashboard bearer (401 without/with a wrong token)', async () => {
      expect((await fetch(`${url}/api/metrics/overview`)).status).toBe(401);
      expect(
        (await fetch(`${url}/api/metrics/overview`, { headers: { authorization: 'Bearer nope' } }))
          .status,
      ).toBe(401);
    });
  });

  // --- US2: cost & usage ---

  describe('GET /api/metrics/cost', () => {
    const sumPoints = (pts: (number | string)[]) => pts.reduce((a, p) => a + Number(p), 0);

    it('stacks cost by executor, sums tokens by type, keeps series dense (R3 invariant)', async () => {
      const body = await get('/api/metrics/cost'); // 7d default; data seeded in US1
      expect(body.cost_by_executor.granularity).toBe('day');

      // Invariant: every series is zero-filled to buckets.length.
      for (const block of [body.cost_by_executor, body.tokens_by_type, body.cost_per_run]) {
        for (const s of block.series) expect(s.points.length).toBe(block.buckets.length);
      }

      // mock spend totals 0.50 across buckets; every point is a money string.
      const mock = body.cost_by_executor.series.find((s: { key: string }) => s.key === 'mock');
      expect(mock).toBeDefined();
      expect(mock.points.every((p: unknown) => typeof p === 'string')).toBe(true);
      expect(sumPoints(mock.points)).toBeCloseTo(0.5, 4);

      // Exactly the four canonical token series; input sums to 500 (R8 coalesce).
      expect(body.tokens_by_type.series.map((s: { key: string }) => s.key)).toEqual([
        'input',
        'output',
        'cache_read',
        'cache_creation',
      ]);
      const input = body.tokens_by_type.series.find((s: { key: string }) => s.key === 'input');
      expect(sumPoints(input.points)).toBe(500);

      // cost_per_run is a single money series.
      expect(body.cost_per_run.series.map((s: { key: string }) => s.key)).toEqual(['cost_per_run']);
    });

    it('serves top_workspaces_by_cost only without a workspace filter (US2 AS3)', async () => {
      const all = await get('/api/metrics/cost');
      expect(all.top_workspaces_by_cost.length).toBeGreaterThan(0);
      expect(all.top_workspaces_by_cost.length).toBeLessThanOrEqual(10);
      // Ordered by spend desc — ws1 (0.50) leads.
      expect(Number(all.top_workspaces_by_cost[0].total_cost_usd)).toBeCloseTo(0.5, 4);

      const scoped = await get(`/api/metrics/cost?workspace_id=${ws1}`);
      expect(scoped.top_workspaces_by_cost).toEqual([]);
    });

    it('uses hourly UTC buckets for the 24h period (M4/R2)', async () => {
      const body = await get('/api/metrics/cost?period=24h');
      expect(body.cost_by_executor.granularity).toBe('hour');
      const n = body.cost_by_executor.buckets.length;
      expect(n).toBeGreaterThanOrEqual(24);
      expect(n).toBeLessThanOrEqual(25);
      // Every bucket start is an exact UTC hour boundary, independent of TZ (M4).
      for (const iso of body.cost_by_executor.buckets) {
        const d = new Date(iso);
        expect(d.getUTCMinutes()).toBe(0);
        expect(d.getUTCSeconds()).toBe(0);
      }
    });
  });

  // --- US3: reliability ---

  describe('GET /api/metrics/reliability', () => {
    let ws3: string;
    const now = new Date();
    // ISO of the UTC day-start `off` days from today.
    const dayStart = (off: number) =>
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + off),
      ).toISOString();

    beforeAll(async () => {
      const p3 = await seedPipeline(db.db, { ticketKey: 'BRIG-3' });
      ws3 = p3.workspaceId;
      // A run that STARTS on day D-2 (23:30 UTC) and FINISHES on day D-1
      // (00:30 UTC) — created and finished sit in different UTC day buckets.
      const created = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 23, 30),
      );
      const finished = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 30),
      );
      await db.db.insert(schema.runs).values({
        workspaceId: ws3,
        ticketId: p3.ticketId,
        agentId: p3.agentId,
        executorType: 'mock',
        status: 'succeeded',
        createdAt: created,
        startedAt: created,
        finishedAt: finished, // duration = 1h = 3600s
      });
    });

    it('anchors the duration bucket on finished_at, not created_at (M2/FR-005a)', async () => {
      const body = await get(`/api/metrics/reliability?workspace_id=${ws3}`);
      const buckets = body.duration_median_s.buckets;
      const createdIdx = buckets.indexOf(dayStart(-2));
      const finishedIdx = buckets.indexOf(dayStart(-1));
      expect(createdIdx).toBeGreaterThanOrEqual(0);
      expect(finishedIdx).toBeGreaterThanOrEqual(0);

      // The 3600s duration lands in the FINISHED-day bucket, zero in the created day.
      const med = body.duration_median_s.series[0].points;
      expect(Number(med[finishedIdx])).toBeCloseTo(3600, 0);
      expect(Number(med[createdIdx])).toBe(0);

      // The status count sits in the CREATED-day bucket (created_at anchor).
      const succ = body.runs_by_status.series.find((s: { key: string }) => s.key === 'succeeded');
      expect(Number(succ.points[createdIdx])).toBe(1);
      expect(Number(succ.points[finishedIdx])).toBe(0);
    });

    it('runs_by_status totals match the overview counters (SC-003 consistency)', async () => {
      const [rel, ov] = await Promise.all([
        get('/api/metrics/reliability'),
        get('/api/metrics/overview'),
      ]);
      const totals: Record<string, number> = {};
      for (const s of rel.runs_by_status.series) {
        totals[s.key] = s.points.reduce((a: number, p: number | string) => a + Number(p), 0);
      }
      for (const [status, count] of Object.entries(ov.run_count_by_status)) {
        expect(totals[status] ?? 0).toBe(count);
      }
    });

    it('exposes success_rate and retry_rate as single 0..1 series', async () => {
      const body = await get('/api/metrics/reliability');
      expect(body.success_rate.series.map((s: { key: string }) => s.key)).toEqual(['success_rate']);
      expect(body.retry_rate.series.map((s: { key: string }) => s.key)).toEqual(['retry_rate']);
      for (const p of body.success_rate.series[0].points) {
        expect(Number(p)).toBeGreaterThanOrEqual(0);
        expect(Number(p)).toBeLessThanOrEqual(1);
      }
    });
  });

  // --- US4: activity ---

  describe('GET /api/metrics/activity', () => {
    let ws4: string;
    let ws4Name: string;
    const sumSeries = (series: { key: string; points: (number | string)[] }[]) => {
      const out: Record<string, number> = {};
      for (const s of series) out[s.key] = s.points.reduce((a, p) => a + Number(p), 0);
      return out;
    };

    beforeAll(async () => {
      const p4 = await seedPipeline(db.db, { ticketKey: 'BRIG-4' });
      ws4 = p4.workspaceId;
      const [w4] = await db.db
        .select({ name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ws4));
      ws4Name = w4.name;
      // A second agent WITH a role; p4's agent has role NULL (seedPipeline).
      const [devAgent] = await db.db
        .insert(schema.agents)
        .values({
          workspaceId: ws4,
          executorId: p4.executorId,
          name: 'Dev',
          key: 'dev',
          role: 'Developer',
          instruction: 'x',
          statusSuccess: 'S',
          statusFailure: 'F',
        })
        .returning({ id: schema.agents.id });

      await db.db.insert(schema.runs).values([
        // manual source, Developer role.
        { workspaceId: ws4, ticketId: p4.ticketId, agentId: devAgent.id, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(2), triggerEvent: { source: 'manual' } },
        // webhook source, NULL role (p4 agent).
        { workspaceId: ws4, ticketId: p4.ticketId, agentId: p4.agentId, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(2), triggerEvent: { source: 'webhook' } },
        // NULL trigger_event → __unknown__ source; Developer role.
        { workspaceId: ws4, ticketId: p4.ticketId, agentId: devAgent.id, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(2), triggerEvent: null },
      ]);
    });

    it('buckets counts by source/role with an __unknown__ category for NULLs (FR-014)', async () => {
      const body = await get(`/api/metrics/activity?workspace_id=${ws4}`);
      const bySource = sumSeries(body.by_source.series);
      expect(bySource.manual).toBe(1);
      expect(bySource.webhook).toBe(1);
      expect(bySource.__unknown__).toBe(1); // NULL trigger source, not lost

      const byRole = sumSeries(body.by_role.series);
      expect(byRole.Developer).toBe(2);
      expect(byRole.__unknown__).toBe(1); // NULL role, not lost
    });

    it('labels the by_workspace series with the workspace name', async () => {
      const body = await get(`/api/metrics/activity?workspace_id=${ws4}`);
      const wsSeries = body.by_workspace.series.find((s: { key: string }) => s.key === ws4);
      expect(wsSeries).toBeDefined();
      expect(wsSeries.label).toBe(ws4Name);
      expect(wsSeries.points.reduce((a: number, p: number | string) => a + Number(p), 0)).toBe(3);
    });
  });

  // --- US5: human-in-the-loop ---

  describe('GET /api/metrics/human', () => {
    let ws5: string;
    const nonZero = (pts: (number | string)[]) => pts.map(Number).filter((n) => n > 0);
    const sumSeries = (series: { key: string; points: (number | string)[] }[]) => {
      const out: Record<string, number> = {};
      for (const s of series) out[s.key] = s.points.reduce((a, p) => a + Number(p), 0);
      return out;
    };

    beforeAll(async () => {
      const p5 = await seedPipeline(db.db, { ticketKey: 'BRIG-5' });
      ws5 = p5.workspaceId;
      await db.db.insert(schema.humanTasks).values([
        // Resolved: latency = 2h = 7200s (question).
        { workspaceId: ws5, ticketId: p5.ticketId, kind: 'question', title: 'Q', status: 'resolved', createdAt: hoursAgo(4), resolvedAt: hoursAgo(2) },
        // Still open (blocker) — excluded from latency + closed_by_kind.
        { workspaceId: ws5, ticketId: p5.ticketId, kind: 'blocker', title: 'B', status: 'open', createdAt: hoursAgo(3) },
      ]);
      // Extra tickets so the two ACTIVE runs don't collide on runs_one_active.
      const [tA, tB] = await db.db
        .insert(schema.tickets)
        .values([
          { workspaceId: ws5, jiraKey: 'BRIG-5A', jiraId: '5A', summary: 'A' },
          { workspaceId: ws5, jiraKey: 'BRIG-5B', jiraId: '5B', summary: 'B' },
        ])
        .returning({ id: schema.tickets.id });
      // 3 runs in one bucket: 1 awaiting_human → share = 1/3.
      await db.db.insert(schema.runs).values([
        { workspaceId: ws5, ticketId: tA.id, agentId: p5.agentId, executorType: 'mock', status: 'awaiting_human', createdAt: hoursAgo(2), startedAt: hoursAgo(2) },
        { workspaceId: ws5, ticketId: tB.id, agentId: p5.agentId, executorType: 'mock', status: 'running', createdAt: hoursAgo(2), startedAt: hoursAgo(2) },
        { workspaceId: ws5, ticketId: p5.ticketId, agentId: p5.agentId, executorType: 'mock', status: 'succeeded', createdAt: hoursAgo(2), startedAt: hoursAgo(2), finishedAt: hoursAgo(1) },
      ]);
    });

    it('measures latency over resolved tasks only; splits opened/closed by kind', async () => {
      const body = await get(`/api/metrics/human?workspace_id=${ws5}`);
      // Only the resolved task (7200s) contributes to latency.
      expect(nonZero(body.latency_median_s.series[0].points)).toEqual([7200]);

      // Opened counts both (question + blocker); closed only the resolved question.
      const opened = sumSeries(body.opened_by_kind.series);
      expect(opened.question).toBe(1);
      expect(opened.blocker).toBe(1);
      const closed = sumSeries(body.closed_by_kind.series);
      expect(closed.question).toBe(1);
      expect(closed.blocker ?? 0).toBe(0);
    });

    it('reports the awaiting_human share of runs per bucket', async () => {
      const body = await get(`/api/metrics/human?workspace_id=${ws5}`);
      const share = nonZero(body.awaiting_human_share.series[0].points);
      expect(share).toHaveLength(1);
      expect(share[0]).toBeCloseTo(1 / 3, 4);
    });

    it('ignores executor_type entirely on this tab (H1/FR-011a)', async () => {
      const withExec = await get(`/api/metrics/human?workspace_id=${ws5}&executor_type=kimi`);
      // human_tasks metrics unchanged, and the runs-derived share is unchanged
      // (there are no kimi runs in ws5, yet the share is still 1/3 — proof the
      // executor filter was not applied).
      expect(sumSeries(withExec.opened_by_kind.series).question).toBe(1);
      expect(nonZero(withExec.awaiting_human_share.series[0].points)[0]).toBeCloseTo(1 / 3, 4);
    });
  });

  // --- Polish: pre-aggregation smoke (M9/FR-013/SC-004) ---

  describe('pre-aggregation (response is bucketed, not row-by-row)', () => {
    it('bucket count depends on period+granularity, NOT the number of runs', async () => {
      const p6 = await seedPipeline(db.db, { ticketKey: 'BRIG-6' });
      const ws6 = p6.workspaceId;
      // A LOT of runs in one workspace — terminal so runs_one_active is untouched.
      const many: (typeof schema.runs.$inferInsert)[] = Array.from({ length: 40 }, () => ({
        workspaceId: ws6,
        ticketId: p6.ticketId,
        agentId: p6.agentId,
        executorType: 'mock',
        status: 'succeeded' as const,
        createdAt: hoursAgo(3),
        startedAt: hoursAgo(3),
        finishedAt: hoursAgo(2),
        costUsd: '0.0100',
      }));
      await db.db.insert(schema.runs).values(many);

      // A second workspace with a SINGLE run for the comparison.
      const p7 = await seedPipeline(db.db, { ticketKey: 'BRIG-7' });
      await db.db.insert(schema.runs).values({
        workspaceId: p7.workspaceId,
        ticketId: p7.ticketId,
        agentId: p7.agentId,
        executorType: 'mock',
        status: 'succeeded',
        createdAt: hoursAgo(3),
        startedAt: hoursAgo(3),
        finishedAt: hoursAgo(2),
        costUsd: '0.0100',
      });

      const heavy = await get(`/api/metrics/cost?workspace_id=${ws6}`);
      const light = await get(`/api/metrics/cost?workspace_id=${p7.workspaceId}`);

      // 40 rows vs 1 → identical bucket count (bounded by the 7d/day grid).
      expect(heavy.cost_by_executor.buckets.length).toBe(light.cost_by_executor.buckets.length);
      expect(heavy.cost_by_executor.buckets.length).toBeLessThanOrEqual(32);
      // Each series still carries exactly one point per bucket.
      for (const s of heavy.cost_by_executor.series) {
        expect(s.points.length).toBe(heavy.cost_by_executor.buckets.length);
      }
    });
  });
});

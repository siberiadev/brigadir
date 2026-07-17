import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
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
 * Feature 017 (US2/US6 + T034): GET /api/home/summary — the atomic tile
 * counters + all-period platform spend, cross-workspace. Includes the SC-004
 * consistency invariants: the platform spend equals the sum of the
 * per-workspace cost figures, and every counter matches the filtered
 * list/count endpoint it summarizes.
 */
describe('home summary (feature 017)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let ws1: string;
  let ws2: string;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  // Seeding runs INSIDE the suite (after the zero-state assertion below) —
  // vitest executes `it` blocks in declaration order within a file.
  async function seedAll() {
    const p1 = await seedPipeline(db.db, { ticketKey: 'BRIG-1' });
    const p2 = await seedPipeline(db.db, { ticketKey: 'BRIG-2' });
    ws1 = p1.workspaceId;
    ws2 = p2.workspaceId;

    // Extra ticket in ws1 so two ACTIVE runs coexist without tripping the
    // runs_one_active partial unique index (one active per ticket+agent).
    const [extraTicket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: ws1, jiraKey: 'BRIG-9', jiraId: '10009', summary: 'Extra' })
      .returning({ id: schema.tickets.id });

    type RunSeed = typeof schema.runs.$inferInsert;
    const runs: RunSeed[] = [
      // Live: 2 running (one per workspace) + 1 queued (ws1, extra ticket).
      { workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'running', startedAt: hoursAgo(0.5), createdAt: hoursAgo(0.6), costUsd: '0.1000' },
      { workspaceId: ws2, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock', status: 'running', startedAt: hoursAgo(0.2), createdAt: hoursAgo(0.3) },
      { workspaceId: ws1, ticketId: extraTicket.id, agentId: p1.agentId, executorType: 'mock', status: 'queued', createdAt: hoursAgo(0.1) },
      // Attention window: failed 1h ago + timed_out 2h ago; a 25h-old failure
      // is OUTSIDE the finished_at window but INSIDE the 7d spend window.
      { workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'failed', startedAt: hoursAgo(1.2), finishedAt: hoursAgo(1), createdAt: hoursAgo(1.3), costUsd: '0.2000' },
      { workspaceId: ws2, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock', status: 'timed_out', startedAt: hoursAgo(2.5), finishedAt: hoursAgo(2), createdAt: hoursAgo(2.6), costUsd: null },
      { workspaceId: ws2, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock', status: 'failed', startedAt: hoursAgo(25.5), finishedAt: hoursAgo(25), createdAt: hoursAgo(26), costUsd: '0.5000' },
      // Old succeeded run inside 30d only.
      { workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock', status: 'succeeded', startedAt: hoursAgo(24 * 20), finishedAt: hoursAgo(24 * 20 - 1), createdAt: hoursAgo(24 * 20), costUsd: '1.0000' },
    ];
    for (const r of runs) await db.db.insert(schema.runs).values(r);

    // Human tasks: two open (one per workspace), one resolved (excluded).
    await db.db.insert(schema.humanTasks).values([
      { workspaceId: ws1, ticketId: p1.ticketId, kind: 'question', title: 'Q1', status: 'open' },
      { workspaceId: ws2, ticketId: p2.ticketId, kind: 'blocker', title: 'Q2', status: 'open' },
      { workspaceId: ws1, ticketId: p1.ticketId, kind: 'review', title: 'Done', status: 'resolved' },
    ]);
  }

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  const summary = () => fetch(`${url}/api/home/summary`, { headers: authHeaders }).then((r) => r.json());

  it('returns all zeros (200, never an error) on an idle platform', async () => {
    const body = await summary();
    expect(body).toEqual({
      running: 0,
      queued: 0,
      attention_24h: { failed: 0, timed_out: 0 },
      human_open: 0,
      spend: {
        '24h': { total_cost_usd: '0', run_count: 0 },
        '7d': { total_cost_usd: '0', run_count: 0 },
        '30d': { total_cost_usd: '0', run_count: 0 },
      },
    });
  });

  it('counts live and attention runs cross-workspace; the 25h-old failure is excluded', async () => {
    await seedAll();
    const body = await summary();
    expect(body.running).toBe(2);
    expect(body.queued).toBe(1);
    expect(body.attention_24h).toEqual({ failed: 1, timed_out: 1 });
    expect(body.human_open).toBe(2);
  });

  it('spend sums cost_usd per created_at window (null cost counted, contributes 0)', async () => {
    const body = await summary();
    // Within 24h: 0.10 + 0.20 + two null-cost live runs.
    expect(Number(body.spend['24h'].total_cost_usd)).toBeCloseTo(0.3, 4);
    expect(body.spend['24h'].run_count).toBe(5);
    // 7d adds the 25h-old 0.50 failure.
    expect(Number(body.spend['7d'].total_cost_usd)).toBeCloseTo(0.8, 4);
    expect(body.spend['7d'].run_count).toBe(6);
    // 30d adds the old 1.00 succeeded run.
    expect(Number(body.spend['30d'].total_cost_usd)).toBeCloseTo(1.8, 4);
    expect(body.spend['30d'].run_count).toBe(7);
  });

  it('platform spend equals the sum of the per-workspace cost figures (SC-004)', async () => {
    const body = await summary();
    for (const period of ['24h', '7d', '30d'] as const) {
      const [c1, c2] = await Promise.all(
        [ws1, ws2].map((id) =>
          fetch(`${url}/api/workspaces/${id}/runs/cost?period=${period}`, { headers: authHeaders }).then((r) => r.json()),
        ),
      );
      expect(Number(body.spend[period].total_cost_usd)).toBeCloseTo(
        Number(c1.total_cost_usd) + Number(c2.total_cost_usd),
        4,
      );
      expect(body.spend[period].run_count).toBe(c1.run_count + c2.run_count);
    }
  });

  it('counters match the endpoints they summarize (T034 consistency invariants)', async () => {
    const body = await summary();

    const globalTotal = (query: string) =>
      fetch(`${url}/api/runs?${query}`, { headers: authHeaders })
        .then((r) => r.json())
        .then((b) => b.total);

    expect(await globalTotal('status=running')).toBe(body.running);
    expect(await globalTotal('status=queued')).toBe(body.queued);
    expect(await globalTotal('status=failed,timed_out&finished_within=24h')).toBe(
      body.attention_24h.failed + body.attention_24h.timed_out,
    );

    const count = await fetch(`${url}/api/human-tasks/count`, { headers: authHeaders }).then((r) => r.json());
    expect(count.open).toBe(body.human_open);
  });

  it('requires the dashboard bearer (401 without/with a wrong token)', async () => {
    expect((await fetch(`${url}/api/home/summary`)).status).toBe(401);
    expect(
      (await fetch(`${url}/api/home/summary`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });
});

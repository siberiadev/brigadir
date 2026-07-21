import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import type { ChannelHealthResponse } from '@brigadir/contracts';
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
 * Feature 027 (US4) — GET /api/channel-health status matrix, window semantics,
 * affected-runs cap, deployment-guard verdict, and the runs-list
 * `callback_alert` projection (FR-015). Window/threshold are read lazily per
 * request, so per-test env overrides apply without reboots.
 */
describe('channel health aggregate (feature 027, US4)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let scratch: string;
  let workspaceId: string;
  let agentId: string;
  let nextTicket = 800;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'brigadir-health-it-'));
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    await freshArtifact(scratch);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [BackendAppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    const p = await seedPipeline(db.db, { ticketKey: `BRIG-${nextTicket++}` });
    workspaceId = p.workspaceId;
    agentId = p.agentId;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
    await rm(scratch, { recursive: true, force: true });
    delete process.env.BRIGADIR_MCP_SERVER_ENTRY;
    delete process.env.BRIGADIR_MCP_SERVER_SRC;
    delete process.env.BRIGADIR_CHANNEL_HEALTH_WINDOW_MS;
    delete process.env.BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD;
  });

  beforeEach(async () => {
    // Каждый тест начинает с чистого журнала событий (счётчики оконные).
    await db.db.delete(schema.runEvents);
    delete process.env.BRIGADIR_CHANNEL_HEALTH_WINDOW_MS;
    delete process.env.BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD;
  });

  async function freshArtifact(base: string): Promise<void> {
    const entry = join(base, 'dist', 'main.js');
    const src = join(base, 'src');
    await mkdir(join(base, 'dist'), { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'a.ts'), 'x');
    await writeFile(entry, 'built');
    await utimes(join(src, 'a.ts'), new Date(1_000_000), new Date(1_000_000));
    await utimes(entry, new Date(2_000_000), new Date(2_000_000));
    process.env.BRIGADIR_MCP_SERVER_ENTRY = entry;
    process.env.BRIGADIR_MCP_SERVER_SRC = src;
  }

  async function seedRun(status = 'failed'): Promise<string> {
    // Свой тикет на каждый прогон — partial unique index `runs_one_active`
    // допускает максимум один активный прогон на (ticket, agent).
    const key = `BRIG-${nextTicket++}`;
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: key, summary: 'health' })
      .returning({ id: schema.tickets.id });
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        agentId,
        ticketId: ticket.id,
        executorType: 'claude_cli',
        status: status as (typeof schema.runs.$inferInsert)['status'],
      })
      .returning({ id: schema.runs.id });
    return run.id;
  }

  async function seedEvent(runId: string, type: string, ageMs = 0, payload: unknown = {}): Promise<void> {
    await db.db.insert(schema.runEvents).values({
      runId,
      type,
      payload: payload as Record<string, unknown>,
      createdAt: new Date(Date.now() - ageMs),
    });
  }

  async function getHealth(): Promise<ChannelHealthResponse> {
    const res = await fetch(`${url}/api/channel-health`, {
      headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ChannelHealthResponse;
  }

  it('requires the dashboard bearer (401 without)', async () => {
    const res = await fetch(`${url}/api/channel-health`);
    expect(res.status).toBe(401);
  });

  it('fresh system → healthy, null last-success, zero counts, guard ok', async () => {
    const body = await getHealth();
    expect(body.status).toBe('healthy');
    expect(body.last_successful_callback_at).toBeNull();
    expect(body.channel_failures_in_window).toBe(0);
    expect(body.probe_failures_in_window).toBe(0);
    expect(body.deployment_guard).toEqual({ ok: true, reason: null });
    expect(body.affected_runs).toEqual([]);
    expect(body.window_ms).toBe(15 * 60_000);
    expect(body.failure_threshold).toBe(3);
  });

  it('a single channel_down probe failure trips degraded', async () => {
    const runId = await seedRun('queued');
    await seedEvent(runId, 'channel_down', 0, { probe_url: 'x', consecutive: 1, retry_in_ms: 1 });
    const body = await getHealth();
    expect(body.status).toBe('degraded');
    expect(body.probe_failures_in_window).toBe(1);
    expect(body.affected_runs.map((r) => r.run_id)).toContain(runId);
  });

  it('channel_failure count below the threshold stays healthy; at the threshold → degraded', async () => {
    const runId = await seedRun();
    await seedEvent(runId, 'channel_failure');
    await seedEvent(runId, 'channel_failure');
    let body = await getHealth();
    expect(body.status).toBe('healthy'); // 2 < 3
    expect(body.channel_failures_in_window).toBe(2);
    // Прогон уже «затронут» и до degraded-порога (click-through работает раньше алерта).
    expect(body.affected_runs.map((r) => r.run_id)).toContain(runId);

    await seedEvent(runId, 'channel_failure');
    body = await getHealth();
    expect(body.status).toBe('degraded');
    expect(body.channel_failures_in_window).toBe(3);
  });

  it('events older than the window are ignored (auto-recovery)', async () => {
    const runId = await seedRun();
    // 3 отказа, но все старше окна 15 мин.
    for (let i = 0; i < 3; i++) await seedEvent(runId, 'channel_failure', 20 * 60_000);
    await seedEvent(runId, 'channel_down', 20 * 60_000, {});
    const body = await getHealth();
    expect(body.status).toBe('healthy');
    expect(body.channel_failures_in_window).toBe(0);
    expect(body.probe_failures_in_window).toBe(0);
    expect(body.affected_runs).toEqual([]);
  });

  it('window and threshold are configurable per request (lazy env)', async () => {
    const runId = await seedRun();
    await seedEvent(runId, 'channel_failure', 20 * 60_000);
    process.env.BRIGADIR_CHANNEL_HEALTH_WINDOW_MS = String(60 * 60_000); // окно 1 час
    process.env.BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD = '1';
    const body = await getHealth();
    expect(body.window_ms).toBe(60 * 60_000);
    expect(body.failure_threshold).toBe(1);
    expect(body.status).toBe('degraded'); // тот же старый event теперь в окне и ≥ порога
  });

  it('affected_runs is distinct, newest-first, capped at 20', async () => {
    const runIds: string[] = [];
    for (let i = 0; i < 22; i++) {
      const runId = await seedRun();
      runIds.push(runId);
      // Два события на прогон — distinct не должен дублировать.
      await seedEvent(runId, 'channel_failure', (22 - i) * 1000);
      await seedEvent(runId, 'undelivered_report', (22 - i) * 1000, { report: {}, run_status: 'cancelled', source: 'periodic_reconcile' });
    }
    const body = await getHealth();
    expect(body.affected_runs).toHaveLength(20);
    const ids = body.affected_runs.map((r) => r.run_id);
    expect(new Set(ids).size).toBe(20);
    // Новейший (наименьший age) — первым.
    expect(ids[0]).toBe(runIds[21]);
  });

  it('last_successful_callback_at counts ONLY progress events tagged via=callback', async () => {
    const runId = await seedRun('running');
    // Наблюдение stream-parser'а (без тега) — НЕ считается.
    await seedEvent(runId, 'progress', 0, { stage: 'x', message: 'observed' });
    let body = await getHealth();
    expect(body.last_successful_callback_at).toBeNull();

    await seedEvent(runId, 'progress', 0, { stage: 'x', message: 'delivered', via: 'callback' });
    body = await getHealth();
    expect(body.last_successful_callback_at).not.toBeNull();
  });

  it('a missing tool-server artifact makes the guard verdict degraded', async () => {
    // Отдельный boot: у сервиса мемоизация вердикта на 10 с.
    process.env.BRIGADIR_MCP_SERVER_ENTRY = join(scratch, 'nope', 'main.js');
    const moduleRef = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    const app2 = moduleRef.createNestApplication();
    await app2.init();
    await app2.listen(0);
    try {
      const res = await fetch(`${await app2.getUrl()}/api/channel-health`, {
        headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChannelHealthResponse;
      expect(body.deployment_guard).toEqual({ ok: false, reason: 'missing' });
      expect(body.status).toBe('degraded');
    } finally {
      await app2.close();
      await freshArtifact(scratch);
    }
  });

  it('runs list projects callback_alert from undelivered_report/channel_failure events (FR-015)', async () => {
    const alerted = await seedRun('cancelled');
    const clean = await seedRun('succeeded');
    await seedEvent(alerted, 'channel_failure');

    const res = await fetch(`${url}/api/workspaces/${workspaceId}/runs?page_size=100`, {
      headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ run_id: string; callback_alert: boolean }> };
    const byId = new Map(body.items.map((i) => [i.run_id, i.callback_alert]));
    expect(byId.get(alerted)).toBe(true);
    expect(byId.get(clean)).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { join } from 'node:path';
import { RECONCILE_QUEUE } from '@brigadir/queues';
import type { ReconcileStatusResponse, ReconcileTriggerResponse } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import {
  startDatabase,
  startRedis,
  TEST_DASHBOARD_TOKEN,
  DbHarness,
  RedisHarness,
} from './harness';

/**
 * Дашборд-обвязка реконсайл-цикла: GET /api/reconcile/status (расписание для
 * отсчёта «Next sync in …») и POST /api/reconcile/trigger («Sync now»).
 * Backend бутится БЕЗ воркера — ручные job'ы остаются waiting, что и делает
 * проверки статуса/дедупа детерминированными.
 *
 * Порядок тестов значим: «нет шедулера» идёт до upsert'а расписания.
 */
describe('reconcile status + manual trigger endpoints', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let queue: Queue;

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

    queue = moduleRef.get<Queue>(getQueueToken(RECONCILE_QUEUE), { strict: false });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  async function getStatus(): Promise<ReconcileStatusResponse> {
    const res = await fetch(`${url}/api/reconcile/status`, {
      headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ReconcileStatusResponse;
  }

  async function postTrigger(): Promise<ReconcileTriggerResponse> {
    const res = await fetch(`${url}/api/reconcile/trigger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ReconcileTriggerResponse;
  }

  it('both endpoints require the dashboard bearer (401 without)', async () => {
    expect((await fetch(`${url}/api/reconcile/status`)).status).toBe(401);
    expect((await fetch(`${url}/api/reconcile/trigger`, { method: 'POST' })).status).toBe(401);
  });

  it('no scheduler registered yet → scheduled:false with null fields', async () => {
    const body = await getStatus();
    expect(body.scheduled).toBe(false);
    expect(body.every_ms).toBeNull();
    expect(body.next_run_at).toBeNull();
    expect(body.last_run_at).toBeNull();
  });

  it('after the worker-style upsert → interval and a future next tick', async () => {
    // То же, что делает ReconcileScheduler воркера на бутстрапе.
    await queue.upsertJobScheduler('reconcile', { every: 30_000 });

    const body = await getStatus();
    expect(body.scheduled).toBe(true);
    expect(body.every_ms).toBe(30_000);
    expect(body.next_run_at).not.toBeNull();
    // next — ближайший слот: в будущем, но не дальше одного интервала.
    const next = Date.parse(body.next_run_at!);
    expect(next).toBeGreaterThan(Date.now() - 1000);
    expect(next).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it('trigger enqueues one manual job; a second click deduplicates', async () => {
    const first = await postTrigger();
    expect(first).toEqual({ ok: true, deduplicated: false });

    const second = await postTrigger();
    expect(second).toEqual({ ok: true, deduplicated: true });

    // Ровно один ручной job ждёт в очереди (воркера в этом сьюте нет).
    const pending = await queue.getJobs(['waiting', 'delayed', 'active']);
    const manual = pending.filter((job) => job.data?.manual === true);
    expect(manual).toHaveLength(1);
  });
});

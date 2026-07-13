import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T026 (US3, FR-019/SC-010): GET runs/cost per period (24h/7d/30d) →
 * `total_cost_usd` + `run_count` over the period window.
 */
describe('runs cost figure (T026)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let workspaceId: string;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const p = await seedPipeline(db.db);
    workspaceId = p.workspaceId;

    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const mk = (cost: string | null, createdAt: Date) =>
      db.db.insert(schema.runs).values({
        workspaceId, ticketId: p.ticketId, agentId: p.agentId, executorType: 'mock',
        status: 'succeeded', attempt: 1, costUsd: cost, createdAt,
      });
    await mk('0.1000', hoursAgo(1)); // within 24h
    await mk('0.2000', hoursAgo(48)); // within 7d, outside 24h
    await mk('1.0000', hoursAgo(24 * 20)); // within 30d, outside 7d
    await mk(null, hoursAgo(2)); // null cost within 24h

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
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

  const cost = (period: string) =>
    fetch(`${url}/api/workspaces/${workspaceId}/runs/cost?period=${period}`, { headers: authHeaders }).then((r) => r.json());

  it('24h window sums only the last-24h runs (null cost counted, contributes 0)', async () => {
    const body = await cost('24h');
    expect(body.period).toBe('24h');
    expect(body.run_count).toBe(2); // 0.10 + null
    expect(Number(body.total_cost_usd)).toBeCloseTo(0.1, 4);
  });

  it('7d window includes the 48h run', async () => {
    const body = await cost('7d');
    expect(body.run_count).toBe(3);
    expect(Number(body.total_cost_usd)).toBeCloseTo(0.3, 4);
  });

  it('30d window includes them all', async () => {
    const body = await cost('30d');
    expect(body.run_count).toBe(4);
    expect(Number(body.total_cost_usd)).toBeCloseTo(1.3, 4);
  });

  it('defaults to 7d when period is omitted', async () => {
    const body = await fetch(`${url}/api/workspaces/${workspaceId}/runs/cost`, { headers: authHeaders }).then((r) => r.json());
    expect(body.period).toBe('7d');
  });
});

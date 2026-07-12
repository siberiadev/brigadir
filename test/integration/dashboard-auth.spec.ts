import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { signRunToken } from '@brigadir/contracts';
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
 * T133 (mandatory — dashboard guard, task (g)): `/api/workspaces` requires the
 * shared bearer; the callback routes stay on RunTokenGuard ONLY. The two guards
 * never overlap — a dashboard token cannot authorize a callback, and a run token
 * cannot authorize `/api/workspaces`. Comparison is constant-time (see the guard
 * unit test); here we assert the HTTP outcomes.
 */
describe('dashboard auth matrix (T133)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

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

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('GET /api/workspaces → 401 without a bearer, 401 wrong bearer, 200 correct bearer', async () => {
    const none = await fetch(`${url}/api/workspaces`);
    expect(none.status).toBe(401);

    const wrong = await fetch(`${url}/api/workspaces`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${url}/api/workspaces`, {
      headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('a dashboard token does NOT authorize a callback route (RunTokenGuard only)', async () => {
    const p = await seedPipeline(db.db, { executorType: 'mock', ticketKey: 'BRIG-900' });
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
      })
      .returning({ id: schema.runs.id });

    const res = await fetch(`${url}/api/callbacks/runs/${run.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
      body: JSON.stringify({ stage: 'x', message: 'y' }),
    });
    expect(res.status).toBe(401); // run-token guard rejects the dashboard token
  });

  it('a run token does NOT authorize /api/workspaces (dashboard guard only)', async () => {
    const runToken = signRunToken(
      { sub: 'r', wsp: 'w', tkt: 'BRIG-1', exp: Math.floor(Date.now() / 1000) + 3600 },
      process.env.BRIGADIR_JWT_SECRET!,
    );
    const res = await fetch(`${url}/api/workspaces`, {
      headers: { authorization: `Bearer ${runToken}` },
    });
    expect(res.status).toBe(401);
  });
});

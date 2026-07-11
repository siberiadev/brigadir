import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { join } from 'node:path';

/**
 * T030: GET /health returns 200 { status:'ok', db:'up', redis:'up' } once the
 * DB and Redis are reachable (contracts C7).
 */
describe('GET /health (T030)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    const moduleRef = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
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

  it('reports ok with db and redis up', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string; redis: string };
    expect(body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

const SPA_MARKER = 'BRIGADIR_SPA_STUB_MARKER';

/**
 * T145: the SPA is served statically at `/` with client-route fallback to
 * index.html, but `/api/*` and `/health` ALWAYS route to their handlers (never
 * shadowed). Uses a stub `dist` fixture via WEB_DIST_PATH.
 *
 * Booted via NestFactory.create — the real bootstrap main.api.ts uses. (The
 * @nestjs/testing createNestApplication() harness registers its not-found
 * handler before serve-static's routes, so serve-static only activates under the
 * production bootstrap; see the deviation note in the report.)
 */
describe('serve-static SPA fallback ordering (T145)', () => {
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
    process.env.WEB_DIST_PATH = join(process.cwd(), 'test', 'fixtures', 'web-dist');

    app = await NestFactory.create(BackendAppModule, { logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    delete process.env.WEB_DIST_PATH;
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('GET /health routes to the health handler, not index.html', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SPA_MARKER);
  });

  it('GET /api/workspaces routes to the guarded controller, not index.html', async () => {
    const res = await fetch(`${url}/api/workspaces`, { headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SPA_MARKER);
  });

  it('an unknown /api/* path 404s (excluded from the SPA fallback), never index.html', async () => {
    const res = await fetch(`${url}/api/does-not-exist`, { headers: { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SPA_MARKER);
  });

  it('an unknown client route returns index.html (SPA fallback)', async () => {
    const res = await fetch(`${url}/workspaces/new`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SPA_MARKER);
  });
});

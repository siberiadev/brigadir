import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { DEFAULT_ORCHESTRATOR_INSTRUCTION } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * T039 (US4, FR-021): GET/PUT /api/general-settings round-trips the default
 * orchestrator instruction. GET before any PUT returns the built-in default;
 * PUT persists; an extra key is rejected (.strict()).
 */
describe('general settings API (T039)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let jira: MockJira;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    jira?.server.close();
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  const get = () =>
    fetch(`${url}/api/general-settings`, { headers: authHeaders });
  const put = (body: unknown) =>
    fetch(`${url}/api/general-settings`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(body) });

  it('GET before any PUT returns the built-in default', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.default_orchestrator_instruction).toBe(DEFAULT_ORCHESTRATOR_INSTRUCTION);
  });

  it('PUT then GET round-trips the persisted value', async () => {
    const value = 'You are the custom triage brain. Route or escalate.';
    const putRes = await put({ default_orchestrator_instruction: value });
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).default_orchestrator_instruction).toBe(value);

    const getRes = await get();
    expect((await getRes.json()).default_orchestrator_instruction).toBe(value);
  });

  it('PUT with an extra key is rejected (.strict())', async () => {
    const res = await put({ default_orchestrator_instruction: 'x', bogus: true });
    expect(res.status).toBe(422);
  });
});

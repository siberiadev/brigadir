import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * Feature 028 (T020) — deepseek_api profile CRUD over the live API, per the
 * error matrix in specs/028-deepseek-executor/contracts/
 * deepseek-executor-api.md: create requires a key (422 otherwise);
 * auth/AWS/base-URL fields are foreign (422); the key is write-only
 * (`has_api_key` only, never echoed); update retains an omitted key and 422s
 * a clear-to-keyless. Mirrors kimi-executor-crud.spec.ts.
 */
describe('deepseek_api executors CRUD (feature 028, /api/executors)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const base = () => `${url}/api/executors`;

  const deepseekBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'deepseek_api',
    name: 'deepseek-1',
    model: 'deepseek-v4-flash',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 20,
    max_parallel_runs: 1,
    api_key: 'sk-deepseek-crud',
    ...overrides,
  });

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

  beforeEach(async () => {
    await db.db.delete(schema.agents);
    await db.db.delete(schema.executors);
  });

  async function createDeepseek(overrides: Record<string, unknown> = {}) {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(deepseekBody(overrides)),
    });
    return res;
  }

  it('POST creates a deepseek_api profile (201): snake_case config, has_api_key, no auth field, key never serialized', async () => {
    const res = await createDeepseek();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'deepseek_api',
      name: 'deepseek-1',
      max_parallel_runs: 1,
      has_api_key: true,
      config: {
        model: 'deepseek-v4-flash',
        cli_path: 'claude',
        use_callback_channel: true,
        keep_failed_worktrees: false,
        max_turns: 20,
      },
    });
    // No auth mode is computed for deepseek_api, and no endpoint ever appears.
    expect(body.config.auth).toBeUndefined();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-deepseek-crud');
    expect(serialized).not.toContain('base_url');
    expect(serialized).not.toContain('deepseek.com');
    expect(body.api_key).toBeUndefined();
  });

  it('POST without api_key → 422 at api_key (key required on create)', async () => {
    for (const overrides of [{ api_key: undefined }, { api_key: null }]) {
      const res = await createDeepseek(overrides);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(JSON.stringify(body.details ?? body)).toContain('api_key');
    }
  });

  it('POST with foreign fields (auth / aws_region / base-URL-shaped) → 422', async () => {
    for (const overrides of [
      { auth: 'api_key' },
      { auth: 'bedrock', aws_region: 'eu-west-1' },
      { aws_region: 'eu-west-1' },
      { aws_profile: 'corp' },
      { ca_bundle_path: '/etc/ssl/ca.pem' },
      { base_url: 'https://x.example.com' },
      { anthropic_base_url: 'https://x.example.com' },
    ]) {
      const res = await createDeepseek(overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(422);
    }
  });

  it('PUT with api_key omitted keeps the stored key (has_api_key stays true)', async () => {
    const created = await (await createDeepseek()).json();
    const { api_key: _drop, ...withoutKey } = deepseekBody({ model: 'deepseek-v4-pro' });
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(withoutKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_api_key).toBe(true);
    expect(body.config.model).toBe('deepseek-v4-pro');
  });

  it('PUT with api_key: null (clear-to-keyless) → 422 — a keyless deepseek_api profile cannot exist', async () => {
    const created = await (await createDeepseek()).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(deepseekBody({ api_key: null })),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body.details ?? body)).toContain('api_key');
  });

  it('PUT replacing the key works and stays write-only', async () => {
    const created = await (await createDeepseek()).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(deepseekBody({ api_key: 'sk-deepseek-rotated' })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_api_key).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-deepseek-rotated');
  });

  it('GET list serializes deepseek_api rows with has_api_key and without secrets', async () => {
    await createDeepseek();
    const res = await fetch(`${base()}?page=1&page_size=10`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    const deepseek = body.items.find((i: { type: string }) => i.type === 'deepseek_api');
    expect(deepseek).toBeDefined();
    expect(deepseek.has_api_key).toBe(true);
    expect(deepseek.secrets).toBeUndefined();
    expect(JSON.stringify(deepseek)).not.toContain('sk-deepseek-crud');
  });
});

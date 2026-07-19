import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * Feature 025 (T018) — kimi profile CRUD over the live API, per the error
 * matrix in specs/025-kimi-executor/contracts/kimi-executor-api.md: create
 * requires a key (422 otherwise); auth/AWS/base-URL fields are foreign (422);
 * the key is write-only (`has_api_key` only, never echoed); update retains an
 * omitted key and 422s a clear-to-keyless.
 */
describe('kimi executors CRUD (feature 025, /api/executors)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const base = () => `${url}/api/executors`;

  const kimiBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'kimi',
    name: 'moonshot-1',
    model: 'kimi-k3',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 20,
    max_parallel_runs: 1,
    api_key: 'sk-moonshot-crud',
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

  async function createKimi(overrides: Record<string, unknown> = {}) {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(kimiBody(overrides)),
    });
    return res;
  }

  it('POST creates a kimi profile (201): snake_case config, has_api_key, no auth field, key never serialized', async () => {
    const res = await createKimi();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'kimi',
      name: 'moonshot-1',
      max_parallel_runs: 1,
      has_api_key: true,
      config: {
        model: 'kimi-k3',
        cli_path: 'claude',
        use_callback_channel: true,
        keep_failed_worktrees: false,
        max_turns: 20,
      },
    });
    // No auth mode is computed for kimi, and no endpoint ever appears.
    expect(body.config.auth).toBeUndefined();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-moonshot-crud');
    expect(serialized).not.toContain('base_url');
    expect(serialized).not.toContain('moonshot.ai');
    expect(body.api_key).toBeUndefined();
  });

  it('POST without api_key → 422 at api_key (key required on create)', async () => {
    for (const overrides of [{ api_key: undefined }, { api_key: null }]) {
      const res = await createKimi(overrides);
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
      const res = await createKimi(overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(422);
    }
  });

  it('PUT with api_key omitted keeps the stored key (has_api_key stays true)', async () => {
    const created = await (await createKimi()).json();
    const { api_key: _drop, ...withoutKey } = kimiBody({ model: 'kimi-k2.7' });
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(withoutKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_api_key).toBe(true);
    expect(body.config.model).toBe('kimi-k2.7');
  });

  it('PUT with api_key: null (clear-to-keyless) → 422 — a keyless kimi profile cannot exist', async () => {
    const created = await (await createKimi()).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(kimiBody({ api_key: null })),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body.details ?? body)).toContain('api_key');
  });

  it('PUT replacing the key works and stays write-only', async () => {
    const created = await (await createKimi()).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(kimiBody({ api_key: 'sk-moonshot-rotated' })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_api_key).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-moonshot-rotated');
  });

  it('GET list serializes kimi rows with has_api_key and without secrets', async () => {
    await createKimi();
    const res = await fetch(`${base()}?page=1&page_size=10`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    const kimi = body.items.find((i: { type: string }) => i.type === 'kimi');
    expect(kimi).toBeDefined();
    expect(kimi.has_api_key).toBe(true);
    expect(kimi.secrets).toBeUndefined();
    expect(JSON.stringify(kimi)).not.toContain('sk-moonshot-crud');
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * Global executors CRUD (platform-scoped, 2026-07-13): GET list shape (secrets
 * never serialized), POST create 201, PUT update, GLOBAL name-conflict 409,
 * invalid typed config 422 (foreign field), repository rejected (it moved to
 * agents.behavior). No workspace in the path.
 */
describe('executors CRUD (global /api/executors)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const base = () => `${url}/api/executors`;

  const claudeBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'claude_cli',
    name: 'extra',
    model: 'claude-opus-4-8',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 20,
    max_parallel_runs: 1,
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
    // Platform-scoped: executors no longer cascade from workspaces.
    await db.db.delete(schema.agents);
    await db.db.delete(schema.executors);
  });

  it('POST creates a claude_cli profile (201) with snake_case config; the api_key is never serialized', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ api_key: 's3cr3t' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'claude_cli',
      name: 'extra',
      max_parallel_runs: 1,
      has_api_key: true,
      config: { model: 'claude-opus-4-8', cli_path: 'claude', use_callback_channel: true, max_turns: 20 },
    });
    expect(JSON.stringify(body)).not.toContain('s3cr3t');
    expect(body.secrets).toBeUndefined();
    expect(body.api_key).toBeUndefined();
  });

  it('GET list returns the created executors and never serializes secrets', async () => {
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody()) });
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify({ type: 'mock', name: 'm1', max_parallel_runs: 3 }) });
    const res = await fetch(base(), { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((e: { secrets?: unknown }) => e.secrets === undefined)).toBe(true);
    // Единый пагинированный конверт (реш. 2026-07-15).
    expect(body).toMatchObject({ page: 1, page_size: 10, total: 2 });
  });

  it('PUT updates max_parallel_runs and name (200)', async () => {
    const created = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody()) })
    ).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'renamed', max_parallel_runs: 5 })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: 'renamed', max_parallel_runs: 5 });

    const [row] = await db.db.select().from(schema.executors).where(eq(schema.executors.id, created.id));
    expect(row.maxParallelRuns).toBe(5);
  });

  it('POST with a duplicate name → 409 executor_name_taken (names are GLOBALLY unique)', async () => {
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'dup' })) });
    // Even a different TYPE cannot reuse the name — one flat platform namespace.
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'mock', name: 'dup', max_parallel_runs: 1 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('executor_name_taken');
  });

  it('POST a mock carrying a foreign field (max_turns) → 422', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'mock', name: 'bad', max_parallel_runs: 1, max_turns: 40 }),
    });
    expect(res.status).toBe(422);
  });

  it('POST claude_cli carrying repository → 422 (repository is an agent choice now)', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'badrepo', repository: 'api' })),
    });
    expect(res.status).toBe(422);
  });

  it('old workspace-scoped route is gone → 404', async () => {
    const res = await fetch(`${url}/api/workspaces/00000000-0000-0000-0000-000000000000/executors`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });

  // --- Feature 018 (T008, US1): bedrock auth round-trip + 422 matrix ---

  const bedrockBody = (overrides: Record<string, unknown> = {}) =>
    claudeBody({
      name: 'corp-bedrock',
      model: 'eu.anthropic.claude-opus-4-8',
      auth: 'bedrock',
      aws_region: 'eu-west-1',
      aws_profile: 'corp-dev',
      ca_bundle_path: '/etc/ssl/corp/ca-bundle.pem',
      ...overrides,
    });

  it('POST bedrock profile → 201; snake_case response; camelCase jsonb persisted (T008)', async () => {
    const res = await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(bedrockBody()) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'claude_cli',
      has_api_key: false,
      config: {
        auth: 'bedrock',
        aws_region: 'eu-west-1',
        aws_profile: 'corp-dev',
        ca_bundle_path: '/etc/ssl/corp/ca-bundle.pem',
      },
    });

    const [row] = await db.db.select().from(schema.executors).where(eq(schema.executors.id, body.id));
    expect(row.config).toMatchObject({
      auth: 'bedrock',
      awsRegion: 'eu-west-1',
      awsProfile: 'corp-dev',
      caBundlePath: '/etc/ssl/corp/ca-bundle.pem',
    });
  });

  it('PUT can move a profile between auth modes; bedrock fields round-trip (T008)', async () => {
    const created = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody()) })
    ).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(bedrockBody({ name: 'extra' })),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).config).toMatchObject({ auth: 'bedrock', aws_region: 'eu-west-1' });
  });

  it('422 matrix: bedrock without region; region on host_subscription; api_key string on bedrock (T008)', async () => {
    for (const bad of [
      bedrockBody({ aws_region: undefined }),
      claudeBody({ name: 'b1', auth: 'host_subscription', aws_region: 'eu-west-1' }),
      bedrockBody({ api_key: 'sk-not-here' }),
    ]) {
      const res = await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(bad) });
      expect(res.status).toBe(422);
    }
  });

  // --- Feature 018 (T012, US2): effective auth in responses + key lifecycle across modes ---

  it('legacy rows report the EFFECTIVE auth: stored key → api_key, none → host_subscription (T012)', async () => {
    const withKey = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'kx', api_key: 'sk-1' })) })
    ).json();
    const withoutKey = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'nk' })) })
    ).json();
    // No `auth` was sent — the response still names the effective mode.
    expect(withKey.config.auth).toBe('api_key');
    expect(withoutKey.config.auth).toBe('host_subscription');
    // And nothing was materialized into the stored jsonb (additive rule).
    const [rowWithKey] = await db.db.select().from(schema.executors).where(eq(schema.executors.id, withKey.id));
    expect((rowWithKey.config as Record<string, unknown>).auth).toBeUndefined();
  });

  it('switching a keyed profile to bedrock keeps the sealed blob (inert) — has_api_key stays true (T012)', async () => {
    const created = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ api_key: 'sk-keep' })) })
    ).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(bedrockBody({ name: 'extra' })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.auth).toBe('bedrock');
    expect(body.has_api_key).toBe(true);

    // ...and an explicit null still clears it, even in bedrock mode.
    const cleared = await (
      await fetch(`${base()}/${created.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(bedrockBody({ name: 'extra', api_key: null })),
      })
    ).json();
    expect(cleared.has_api_key).toBe(false);
  });

  it('PUT auth=api_key with omitted key: 200 when a blob is stored, 422 when the profile is keyless (T012)', async () => {
    const keyed = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'k2', api_key: 'sk-2' })) })
    ).json();
    const keyless = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'k3' })) })
    ).json();

    const okRes = await fetch(`${base()}/${keyed.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'k2', auth: 'api_key' })),
    });
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).has_api_key).toBe(true);

    const badRes = await fetch(`${base()}/${keyless.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'k3', auth: 'api_key' })),
    });
    expect(badRes.status).toBe(422);

    // Explicit api_key mode + explicit clear is contradictory → 422 too.
    const clearRes = await fetch(`${base()}/${keyed.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'k2', auth: 'api_key', api_key: null })),
    });
    expect(clearRes.status).toBe(422);
  });

  it('CREATE auth=api_key without a key → 422 (schema-level create rule) (T008)', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'nokey', auth: 'api_key' })),
    });
    expect(res.status).toBe(422);
  });
});

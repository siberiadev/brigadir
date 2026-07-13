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
    concurrency_limit: 1,
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

  it('POST creates a claude_cli executor (201) with snake_case config and no secrets in the response', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ secrets: { api_key: 's3cr3t' } })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'claude_cli',
      name: 'extra',
      concurrency_limit: 1,
      config: { model: 'claude-opus-4-8', cli_path: 'claude', use_callback_channel: true, max_turns: 20 },
    });
    expect(JSON.stringify(body)).not.toContain('s3cr3t');
    expect(body.secrets).toBeUndefined();
  });

  it('GET list returns the created executors and never serializes secrets', async () => {
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody()) });
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify({ type: 'mock', name: 'm1', concurrency_limit: 3 }) });
    const res = await fetch(base(), { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((e: { secrets?: unknown }) => e.secrets === undefined)).toBe(true);
  });

  it('PUT updates concurrency_limit and name (200)', async () => {
    const created = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody()) })
    ).json();
    const res = await fetch(`${base()}/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'renamed', concurrency_limit: 5 })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: 'renamed', concurrency_limit: 5 });

    const [row] = await db.db.select().from(schema.executors).where(eq(schema.executors.id, created.id));
    expect(row.concurrencyLimit).toBe(5);
  });

  it('POST with a duplicate name → 409 executor_name_taken (names are GLOBALLY unique)', async () => {
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'dup' })) });
    // Even a different TYPE cannot reuse the name — one flat platform namespace.
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'mock', name: 'dup', concurrency_limit: 1 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('executor_name_taken');
  });

  it('POST a mock carrying a foreign field (max_turns) → 422', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'mock', name: 'bad', concurrency_limit: 1, max_turns: 40 }),
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
});

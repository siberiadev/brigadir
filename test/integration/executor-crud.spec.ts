import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T008 (US4, FR-020/FR-021): executors CRUD — GET list shape (secrets never
 * serialized), POST create 201, PUT update, name-conflict 409, invalid typed
 * config 422 (foreign field, unknown repository).
 */
describe('executors CRUD (T008)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let workspaceId: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const base = () => `${url}/api/workspaces/${workspaceId}/executors`;

  const claudeBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'claude_cli',
    name: 'extra',
    model: 'claude-opus-4-8',
    cli_path: 'claude',
    repository: 'api',
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
    await db.db.delete(schema.workspaces);
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
        settings: { repositories: [{ name: 'api', git_url: 'g', default_branch: 'main' }] },
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;
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
      config: { model: 'claude-opus-4-8', cli_path: 'claude', repository: 'api', use_callback_channel: true, max_turns: 20 },
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

  it('POST with a duplicate name → 409 executor_name_taken', async () => {
    await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'dup' })) });
    const res = await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody({ name: 'dup' })) });
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

  it('POST claude_cli with an unknown repository → 422', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ name: 'badrepo', repository: 'nope' })),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.issues[0]).toMatchObject({ path: ['repository'], code: 'unknown_repository' });
  });
});

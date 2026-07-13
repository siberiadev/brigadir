import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { openExecutorSecrets } from '@brigadir/executors';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * Profile api_key is WRITE-ONLY (named runner profiles, 2026-07-14): accepted
 * on create/update, sealed with the workspace-credentials AES-256-GCM envelope
 * into executors.secrets, NEVER serialized in any response (`has_api_key`
 * only); `api_key: null` clears; an omitted api_key keeps the stored blob.
 */
describe('executor api_key — write-only round-trip', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const base = () => `${url}/api/executors`;
  const PLAINTEXT = 'sk-ant-integration-secret-42';

  const claudeBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'claude_cli',
    name: 'keyed',
    model: 'claude-sonnet-5',
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
    await db.db.delete(schema.agents);
    await db.db.delete(schema.executors);
  });

  const storedSecrets = async (id: string) => {
    const [row] = await db.db
      .select({ secrets: schema.executors.secrets })
      .from(schema.executors)
      .where(eq(schema.executors.id, id));
    return row.secrets;
  };

  it('create with api_key: has_api_key=true, plaintext never serialized, stored bytes are the sealed envelope', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(claudeBody({ api_key: PLAINTEXT })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.has_api_key).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);

    const blob = await storedSecrets(body.id);
    expect(blob).not.toBeNull();
    // sealed at rest: bytes ≠ plaintext, and the envelope opens back to the key.
    expect(Buffer.from(blob!).includes(Buffer.from(PLAINTEXT, 'utf8'))).toBe(false);
    expect(openExecutorSecrets(blob!).api_key).toBe(PLAINTEXT);

    // ...and the list surface never leaks it either.
    const list = await (await fetch(base(), { headers: authHeaders })).json();
    expect(JSON.stringify(list)).not.toContain(PLAINTEXT);
    expect(list.items[0].has_api_key).toBe(true);
  });

  it('create without api_key: has_api_key=false; a later PUT with a key flips it on', async () => {
    const created = await (
      await fetch(base(), { method: 'POST', headers: authHeaders, body: JSON.stringify(claudeBody()) })
    ).json();
    expect(created.has_api_key).toBe(false);
    expect(await storedSecrets(created.id)).toBeNull();

    const updated = await (
      await fetch(`${base()}/${created.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(claudeBody({ api_key: PLAINTEXT })),
      })
    ).json();
    expect(updated.has_api_key).toBe(true);
    expect(openExecutorSecrets((await storedSecrets(created.id))!).api_key).toBe(PLAINTEXT);
  });

  it('PUT with api_key OMITTED keeps the stored key; api_key: null clears it', async () => {
    const created = await (
      await fetch(base(), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(claudeBody({ api_key: PLAINTEXT })),
      })
    ).json();

    // omitted → keep
    const kept = await (
      await fetch(`${base()}/${created.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(claudeBody({ max_turns: 33 })),
      })
    ).json();
    expect(kept.has_api_key).toBe(true);
    expect(openExecutorSecrets((await storedSecrets(created.id))!).api_key).toBe(PLAINTEXT);

    // explicit null → clear
    const cleared = await (
      await fetch(`${base()}/${created.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(claudeBody({ api_key: null })),
      })
    ).json();
    expect(cleared.has_api_key).toBe(false);
    expect(await storedSecrets(created.id)).toBeNull();
  });

  it('mock rejects api_key (foreign field) → 422', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'mock', name: 'm', max_parallel_runs: 1, api_key: 'x' }),
    });
    expect(res.status).toBe(422);
  });
});

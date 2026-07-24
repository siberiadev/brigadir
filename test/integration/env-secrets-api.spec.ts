import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { encodeJiraCredentials } from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

const BASE = 'https://mock.atlassian.net';

/**
 * Feature 031 US2 (T021): the env-secrets write surface. Values are never
 * echoed — only the names-only view (env_secret_keys) is returned; a key that
 * already exists as a non-secret in the same scope is a 409 (one home per key).
 */
describe('env-secrets API (feature 031, US2)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let url: string;
  let workspaceId: string;
  let agentId: string;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    const seeded = await seedPipeline(db.db, {
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      workspaceSettings: { repositories: [{ name: 'product', git_url: 'git@acme:product.git', default_branch: 'main' }] },
    });
    workspaceId = seeded.workspaceId;
    agentId = seeded.agentId;
    const mod = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = mod.createNestApplication();
    await backend.init();
    await backend.listen(0);
    url = await backend.getUrl();
  }, 240_000);

  afterAll(async () => {
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  const getWs = () => fetch(`${url}/api/workspaces/${workspaceId}`, { headers });
  const putSettings = (body: unknown) =>
    fetch(`${url}/api/workspaces/${workspaceId}/settings`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const putSecrets = (body: unknown) =>
    fetch(`${url}/api/workspaces/${workspaceId}/env-secrets`, { method: 'PUT', headers, body: JSON.stringify(body) });

  async function repoId(): Promise<string> {
    const body = (await (await getWs()).json()) as { repositories: { id: string; name: string }[] };
    return body.repositories.find((r) => r.name === 'product')!.id;
  }

  it('backfills a repo id on first settings write', async () => {
    const res = await putSettings({
      repositories: [{ name: 'product', git_url: 'git@acme:product.git', default_branch: 'main' }],
    });
    expect(res.status).toBe(200);
    const id = await repoId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets a secret and returns only key names, never the value', async () => {
    const SECRET = 'postgres://u:p@h/db-super-secret';
    const res = await putSecrets({ scope: 'workspace', set: { DATABASE_URL: SECRET } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('super-secret'); // value never echoed
    const body = JSON.parse(text) as { env_secret_keys: { workspace: string[] } };
    expect(body.env_secret_keys.workspace).toEqual(['DATABASE_URL']);

    // Re-read confirms names-only, no value.
    const ws = await (await getWs()).text();
    expect(ws).not.toContain('super-secret');
    expect(JSON.parse(ws).env_secret_keys.workspace).toContain('DATABASE_URL');
  });

  it('sets and deletes a per-repository secret keyed by repo id', async () => {
    const id = await repoId();
    await putSecrets({ scope: { repository_id: id }, set: { API_TOKEN: 'tok-abc' } });
    let ws = (await (await getWs()).json()) as { env_secret_keys: { repos: Record<string, string[]> } };
    expect(ws.env_secret_keys.repos[id]).toContain('API_TOKEN');

    await putSecrets({ scope: { repository_id: id }, delete: ['API_TOKEN'] });
    ws = (await (await getWs()).json()) as { env_secret_keys: { repos: Record<string, string[]> } };
    expect(ws.env_secret_keys.repos[id] ?? []).not.toContain('API_TOKEN');
  });

  it('sets a per-agent secret', async () => {
    const res = await putSecrets({ scope: { agent_id: agentId }, set: { QA_TOKEN: 'q' } });
    expect(res.status).toBe(200);
    const ws = (await (await getWs()).json()) as { env_secret_keys: { agents: Record<string, string[]> } };
    expect(ws.env_secret_keys.agents[agentId]).toContain('QA_TOKEN');
  });

  it('rejects a reserved key with 422', async () => {
    const res = await putSecrets({ scope: 'workspace', set: { ANTHROPIC_API_KEY: 'x' } });
    expect(res.status).toBe(422);
  });

  it('409 when a secret key collides with a non-secret value in the same scope', async () => {
    await putSettings({
      env: { SHARED_KEY: 'plain' },
      repositories: [{ name: 'product', git_url: 'git@acme:product.git', default_branch: 'main' }],
    });
    const res = await putSecrets({ scope: 'workspace', set: { SHARED_KEY: 'secret' } });
    expect(res.status).toBe(409);
  });

  it('409 the other direction: a non-secret settings write colliding with a stored secret', async () => {
    await putSecrets({ scope: 'workspace', set: { ONLY_SECRET: 's' } });
    const res = await putSettings({
      env: { ONLY_SECRET: 'now-plain' },
      repositories: [{ name: 'product', git_url: 'git@acme:product.git', default_branch: 'main' }],
    });
    expect(res.status).toBe(409);
  });

  it('404 for an unknown repository scope', async () => {
    const res = await putSecrets({
      scope: { repository_id: '00000000-0000-0000-0000-000000000000' },
      set: { X: '1' },
    });
    expect(res.status).toBe(404);
  });
});

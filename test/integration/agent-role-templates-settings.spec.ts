import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { encodeJiraCredentials } from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import {
  startDatabase,
  startRedis,
  seedPipeline,
  TEST_DASHBOARD_TOKEN,
  DbHarness,
  RedisHarness,
} from './harness';

const BASE = 'https://mock.atlassian.net';
const TOKEN = 'ghp_settings_secret_never_leaks';

/**
 * Feature 030 US3 (contracts/settings-api.md): the management API for the agent
 * role-template source — global GET/PUT and the workspace override on
 * PUT /settings. Token is write-only everywhere (only has_token / an effective
 * level are surfaced), tri-state, and never echoed.
 */
describe('agent role-template source settings API (feature 030, US3)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let url: string;
  let workspaceId: string;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    const seeded = await seedPipeline(db.db, {
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
    workspaceId = seeded.workspaceId;
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

  const getGlobal = () => fetch(`${url}/api/agent-instructions-settings`, { headers });
  const putGlobal = (body: unknown) =>
    fetch(`${url}/api/agent-instructions-settings`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const getWs = () => fetch(`${url}/api/workspaces/${workspaceId}`, { headers });
  const putWsSettings = (body: unknown) =>
    fetch(`${url}/api/workspaces/${workspaceId}/settings`, { method: 'PUT', headers, body: JSON.stringify(body) });

  it('global: empty by default, then set source+token, then clear', async () => {
    expect(await (await getGlobal()).json()).toEqual({ source: null, has_token: false });

    const put = await putGlobal({
      source: { git_url: 'https://github.com/acme/agents.git', subdir: 'roles' },
      token: TOKEN,
    });
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(putText).not.toContain(TOKEN); // token never echoed
    const body = JSON.parse(putText) as { source: { git_url: string }; has_token: boolean };
    expect(body.source.git_url).toContain('acme/agents');
    expect(body.has_token).toBe(true);

    // Clear the source; token clear is independent (tri-state absent = keep).
    await putGlobal({ source: null });
    const after = (await (await getGlobal()).json()) as { source: unknown; has_token: boolean };
    expect(after.source).toBeNull();
    expect(after.has_token).toBe(true); // token retained (not touched)

    await putGlobal({ token: null }); // now clear the token
    expect(((await (await getGlobal()).json()) as { has_token: boolean }).has_token).toBe(false);
  });

  it('global: rejects a file:// url with 422', async () => {
    const res = await putGlobal({ source: { git_url: 'file:///etc' } });
    expect(res.status).toBe(422);
  });

  it('workspace: override + token surface via has_ flags and the effective level, never the token', async () => {
    const res = await putWsSettings({
      agent_instructions: { git_url: 'https://github.com/acme/agents.git' },
      agent_instructions_token: TOKEN,
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as {
      agent_instructions: { git_url: string } | null;
      has_agent_instructions_token: boolean;
      effective_instructions_level: string;
    };
    expect(body.agent_instructions?.git_url).toContain('acme/agents');
    expect(body.has_agent_instructions_token).toBe(true);
    expect(body.effective_instructions_level).toBe('workspace');
  });

  it('workspace: clearing the override drops to built-in (no global set); token tri-state', async () => {
    // Token absent in this patch ⇒ kept; only the source override is cleared.
    const res = await putWsSettings({ agent_instructions: null });
    const body = (await res.json()) as {
      agent_instructions: unknown;
      has_agent_instructions_token: boolean;
      effective_instructions_level: string;
    };
    expect(body.agent_instructions).toBeNull();
    expect(body.has_agent_instructions_token).toBe(true); // untouched
    expect(body.effective_instructions_level).toBe('builtin');

    // Now clear the token explicitly.
    await putWsSettings({ agent_instructions_token: '' });
    const after = (await (await getWs()).json()) as { has_agent_instructions_token: boolean };
    expect(after.has_agent_instructions_token).toBe(false);
  });
});

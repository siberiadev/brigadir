import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const GOOD = { email: 'bot@acme.com', token: 'good-token' };

/**
 * T139 (wizard verify + create; US1 acceptance 1–6, SC-002/009) and T140
 * (statuses endpoint; FR-011). Verify surfaces identity on a good token; a bad
 * token pins `jira_api_token`; an inaccessible board pins `board` distinctly; a
 * board URL round-trips (server extracts the id). Create RE-validates
 * server-side (no row on failure) and persists a `0x01`-encrypted blob.
 */
describe('workspace wizard verify/create + statuses (T139/T140)', () => {
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

  beforeEach(async () => {
    jira.reset();
    jira.expectAuth(GOOD.email, GOOD.token);
    jira.setBotDisplayName('BRIGADIR Bot');
    await db.db.delete(schema.workspaces);
  });

  const verify = (body: unknown) =>
    fetch(`${url}/api/workspaces/verify`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
  const create = (body: unknown) =>
    fetch(`${url}/api/workspaces`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });

  it('verify surfaces bot/project/board_type on a good token+board', async () => {
    const res = await verify({
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      board: '42',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ bot_display_name: 'BRIGADIR Bot', project_key: 'BRIG', board_id: 42, board_type: 'kanban' });
  });

  it('bad token → 422 pinned to jira_api_token (token_invalid)', async () => {
    const res = await verify({
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: 'WRONG',
      board: '42',
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.issues[0]).toMatchObject({ path: ['jira_api_token'], code: 'token_invalid' });
  });

  it('inaccessible board → 422 pinned to board (board_forbidden), distinct from token', async () => {
    const res = await verify({
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      board: '999',
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.issues[0]).toMatchObject({ path: ['board'], code: 'board_forbidden' });
  });

  it('a board URL round-trips — the server extracts the id', async () => {
    const res = await verify({
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      board: `${jira.baseUrl}/jira/software/c/projects/BRIG/boards/42?rapidView=42`,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).board_id).toBe(42);
  });

  it('create re-validates server-side and persists a 0x01-encrypted blob', async () => {
    const res = await create({
      name: 'Acme',
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      expires_at: '2027-07-12T00:00:00.000Z',
      board: '42',
      repositories: [{ name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' }],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: 'Acme', project_key: 'BRIG', board_type: 'kanban' });
    expect(body.jira_api_token).toBeUndefined(); // credentials never serialized
    expect(body.repositories).toHaveLength(1);

    const [row] = await db.db.select().from(schema.workspaces);
    expect(Buffer.from(row.jiraCredentials as Buffer)[0]).toBe(0x01); // encrypted at rest
    expect(row.jiraCredentialExpiresAt?.toISOString()).toBe('2027-07-12T00:00:00.000Z');
  });

  it('a board made inaccessible between verify and create → 422 and NO row written', async () => {
    const res = await create({
      name: 'Acme',
      jira_site_url: jira.baseUrl,
      jira_email: GOOD.email,
      jira_api_token: GOOD.token,
      expires_at: '2027-07-12T00:00:00.000Z',
      board: '999', // inaccessible → server re-verify fails
      repositories: [],
    });
    expect(res.status).toBe(422);
    expect(await db.db.select().from(schema.workspaces)).toHaveLength(0);
  });

  it('GET /:id/statuses returns the flat status set; refresh re-fetches; upstream failure → 502', async () => {
    const created = await (
      await create({
        name: 'Acme',
        jira_site_url: jira.baseUrl,
        jira_email: GOOD.email,
        jira_api_token: GOOD.token,
        expires_at: '2027-07-12T00:00:00.000Z',
        board: '42',
        repositories: [],
      })
    ).json();

    const res = await fetch(`${url}/api/workspaces/${created.id}/statuses`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.statuses)).toBe(true);
    expect(body.statuses.some((s: { name: string }) => s.name === 'Ready for Dev')).toBe(true);
    // flat list — no duplicate ids across the two mock issue-type groups
    const ids = body.statuses.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);

    jira.arm500OnStatuses();
    const fail = await fetch(`${url}/api/workspaces/${created.id}/statuses?refresh=true`, { headers: authHeaders });
    expect(fail.status).toBe(502);
    expect((await fail.json()).error.code).toBe('statuses_unavailable');
  });

  it('REGRESSION (multi-workspace): statuses use the TARGET workspace credentials, not `workspaces LIMIT 1`', async () => {
    // Reproduces the live iteration-5 acceptance failure: a first workspace
    // with an undecodable placeholder blob (the yaml-seeded leftover) made the
    // global memoized JIRA_CLIENT — resolved via LIMIT 1 — poison EVERY
    // workspace's statuses with "unrecognized envelope". The per-workspace
    // JiraClientFactory path must resolve the SECOND workspace on its own row.
    await db.db.insert(schema.workspaces).values({
      name: 'seed-placeholder',
      jiraSiteUrl: 'https://acme.atlassian.net',
      jiraProjectKey: 'JUNK',
      jiraCredentials: Buffer.from('placeholder-jira-credentials'),
    });

    const created = await (
      await create({
        name: 'Real',
        jira_site_url: jira.baseUrl,
        jira_email: GOOD.email,
        jira_api_token: GOOD.token,
        expires_at: '2027-07-12T00:00:00.000Z',
        board: '42',
        repositories: [],
      })
    ).json();

    const res = await fetch(`${url}/api/workspaces/${created.id}/statuses?refresh=true`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statuses.some((s: { name: string }) => s.name === 'Ready for Dev')).toBe(true);
  });
});

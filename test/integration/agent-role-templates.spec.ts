import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const BASE = 'https://mock.atlassian.net';

/**
 * Feature 030 US1 (contracts/role-templates.md §2): the read-only role-template
 * callback endpoints behind RunTokenGuard — catalog list + single body — served
 * from the BUILT-IN defaults with no external source configured. Available to a
 * plain run's token like the Jira read tools; unknown slug ⇒ 404 with the
 * available slugs; foreign token ⇒ 401.
 */
describe('role-template callback tools (feature 030, US1)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let url: string;
  let workspaceId: string;
  let agentId: string;

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
    agentId = seeded.agentId;

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    url = await backend.getUrl();
  }, 240_000);

  afterAll(async () => {
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  let ticketSeq = 0;
  async function runWithToken(status = 'running'): Promise<{ runId: string; token: string }> {
    const [freshTicket] = await db.db
      .insert(schema.tickets)
      .values({
        workspaceId,
        jiraKey: `BRIG-9${++ticketSeq}`,
        jiraId: `9${ticketSeq}`,
        summary: 'template run anchor',
      })
      .returning({ id: schema.tickets.id });
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: freshTicket.id,
        agentId,
        executorType: 'mock',
        status,
      })
      .returning({ id: schema.runs.id });
    const token = signRunToken(
      { sub: run.id, wsp: workspaceId, exp: Math.floor(Date.now() / 1000) + 600 },
      process.env.BRIGADIR_JWT_SECRET!,
    );
    return { runId: run.id, token };
  }

  const call = (path: string, token: string) =>
    fetch(`${url}/api/callbacks/runs/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it('list_role_templates: built-in catalog with source level and the four roles', async () => {
    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/templates`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: { level: string };
      items: { slug: string; role: string; model_hint?: string }[];
    };
    expect(body.source.level).toBe('builtin');
    expect(body.items.map((i) => i.slug)).toEqual(
      expect.arrayContaining(['developer', 'qa', 'reviewer', 'planner']),
    );
    // Summaries carry the catalog fields but no body.
    const dev = body.items.find((i) => i.slug === 'developer');
    expect(dev?.model_hint).toBe('opus');
    expect(dev).not.toHaveProperty('body');
  });

  it('get_role_template: full body for a known slug', async () => {
    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/templates/developer`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; body: string };
    expect(body.slug).toBe('developer');
    expect(body.body).toContain('# Role: Developer');
  });

  it('get_role_template: unknown slug is 404 with the available slugs', async () => {
    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/templates/nope`, token);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; available: string[] };
    expect(body.available).toEqual(expect.arrayContaining(['developer', 'qa']));
  });

  it('guard parity: a foreign token is 401', async () => {
    const { runId, token } = await runWithToken();
    const res = await call(`${runId}/templates`, `${token}x`);
    expect(res.status).toBe(401);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  schema,
  setGlobalInstructionSource,
  setGlobalInstructionToken,
  setWorkspaceInstructionSource,
  setWorkspaceInstructionToken,
} from '@brigadir/database';
import { encodeJiraCredentials, sealSecret } from '@brigadir/jira';
import { signRunToken } from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';

const BASE = 'https://mock.atlassian.net';
// A syntactically-valid https remote that refuses instantly (fast fallback, no
// 30s clone timeout) — stands in for any unreachable/broken template source.
const UNREACHABLE = 'https://127.0.0.1:1/nope.git';
const SECRET_TOKEN = 'ghp_super_secret_never_leaks';

/**
 * Feature 030 US2 (contracts/role-templates.md, quickstart Scenarios 3–6): the
 * DB-driven source RESOLUTION — workspace override ?? global ?? built-ins —
 * precedence, fallback-on-failure with a diagnostic, and token non-leakage.
 * A successful live git fetch is validated separately against the real
 * reference repo; here the configured source is unreachable so the fallback and
 * secrecy paths are exercised deterministically and fast.
 */
describe('agent role-template git source resolution (feature 030, US2)', () => {
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

  beforeEach(async () => {
    // Clean slate: no global, no workspace override.
    await setGlobalInstructionSource(db.db, null);
    await setGlobalInstructionToken(db.db, null);
    await setWorkspaceInstructionSource(db.db, workspaceId, null);
    await setWorkspaceInstructionToken(db.db, workspaceId, null);
  });

  let seq = 0;
  async function runToken(): Promise<{ runId: string; token: string }> {
    const [t] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: `BRIG-7${++seq}`, jiraId: `7${seq}`, summary: 'anchor' })
      .returning({ id: schema.tickets.id });
    const [run] = await db.db
      .insert(schema.runs)
      .values({ workspaceId, ticketId: t.id, agentId, executorType: 'mock', status: 'running' })
      .returning({ id: schema.runs.id });
    const token = signRunToken(
      { sub: run.id, wsp: workspaceId, exp: Math.floor(Date.now() / 1000) + 600 },
      process.env.BRIGADIR_JWT_SECRET!,
    );
    return { runId: run.id, token };
  }

  const listTemplates = async (t: { runId: string; token: string }) => {
    const res = await fetch(`${url}/api/callbacks/runs/${t.runId}/templates`, {
      headers: { authorization: `Bearer ${t.token}` },
    });
    return { status: res.status, text: await res.text() };
  };

  it('falls back to built-ins with a diagnostic when the GLOBAL source is unreachable', async () => {
    await setGlobalInstructionSource(db.db, { git_url: UNREACHABLE });
    const { status, text } = await listTemplates(await runToken());
    expect(status).toBe(200);
    const body = JSON.parse(text) as { source: { level: string; fallback_from?: string; diagnostic?: string }; items: { slug: string }[] };
    expect(body.source.level).toBe('builtin');
    expect(body.source.fallback_from).toBe('global');
    expect(body.source.diagnostic).toBeTruthy();
    expect(body.items.map((i) => i.slug)).toContain('developer');
  });

  it('workspace override takes precedence (fallback_from=workspace) and its token never leaks', async () => {
    await setGlobalInstructionSource(db.db, { git_url: 'https://127.0.0.1:2/global.git' });
    await setWorkspaceInstructionSource(db.db, workspaceId, { git_url: UNREACHABLE });
    await setWorkspaceInstructionToken(db.db, workspaceId, sealSecret(SECRET_TOKEN));

    const { status, text } = await listTemplates(await runToken());
    expect(status).toBe(200);
    const body = JSON.parse(text) as { source: { level: string; fallback_from?: string } };
    // Workspace was tried FIRST (precedence), then global, then built-ins.
    expect(body.source.level).toBe('builtin');
    expect(body.source.fallback_from).toBe('workspace');
    // Constitution V: the sealed token is never echoed anywhere in the response.
    expect(text).not.toContain(SECRET_TOKEN);
  });

  it('clearing the workspace override falls back to the global source resolution', async () => {
    await setGlobalInstructionSource(db.db, { git_url: UNREACHABLE });
    await setWorkspaceInstructionSource(db.db, workspaceId, { git_url: 'https://127.0.0.1:3/ws.git' });
    // Now clear the override → global is the effective (still unreachable → builtin/global fallback).
    await setWorkspaceInstructionSource(db.db, workspaceId, null);

    const { text } = await listTemplates(await runToken());
    const body = JSON.parse(text) as { source: { level: string; fallback_from?: string } };
    expect(body.source.level).toBe('builtin');
    expect(body.source.fallback_from).toBe('global');
  });
});

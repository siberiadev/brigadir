import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import {
  startDatabase,
  startRedis,
  seedPipeline,
  TEST_DASHBOARD_TOKEN,
  DbHarness,
  RedisHarness,
} from './harness';

/**
 * Feature 017 (US5): GET /api/home/workspaces — every workspace with its
 * dashboard aggregates (agent count, newest run, 24h failure count, paused
 * state from settings.enabled) in ONE batched response, created_at ASC.
 */
describe('home workspaces read model (feature 017)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let ws1: string;
  let ws2: string;
  let ws3: string;
  let ws1LastRunId: string;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    // ws1: active, 2 agents, newest run = running, one failed in 24h.
    const p1 = await seedPipeline(db.db, { ticketKey: 'BRIG-1' });
    ws1 = p1.workspaceId;
    await db.db.insert(schema.agents).values({
      workspaceId: ws1,
      executorId: p1.executorId,
      name: 'reviewer',
      key: 'reviewer',
      instruction: 'Review.',
      statusSuccess: 'Done',
      statusFailure: 'Blocked',
    });
    await db.db.insert(schema.runs).values({
      workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock',
      status: 'failed', startedAt: hoursAgo(3.5), finishedAt: hoursAgo(3), createdAt: hoursAgo(3.6),
    });
    const [lastRun] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: ws1, ticketId: p1.ticketId, agentId: p1.agentId, executorType: 'mock',
        status: 'running', startedAt: hoursAgo(0.1), createdAt: hoursAgo(0.2),
      })
      .returning({ id: schema.runs.id });
    ws1LastRunId = lastRun.id;

    // ws2: PAUSED (settings.enabled === false), newest run succeeded, no 24h
    // failures (its only failure finished 30h ago).
    const p2 = await seedPipeline(db.db, {
      ticketKey: 'CHK-1',
      workspaceSettings: { enabled: false },
    });
    ws2 = p2.workspaceId;
    await db.db.insert(schema.runs).values({
      workspaceId: ws2, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock',
      status: 'failed', startedAt: hoursAgo(30.5), finishedAt: hoursAgo(30), createdAt: hoursAgo(31),
    });
    await db.db.insert(schema.runs).values({
      workspaceId: ws2, ticketId: p2.ticketId, agentId: p2.agentId, executorType: 'mock',
      status: 'succeeded', startedAt: hoursAgo(6), finishedAt: hoursAgo(5.9), createdAt: hoursAgo(6.1),
    });

    // ws3: fresh — no agents, no runs.
    const [w3] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'fresh-ws',
        jiraSiteUrl: 'https://fresh.atlassian.net',
        jiraProjectKey: 'FRS',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    ws3 = w3.id;

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

  it('returns every workspace with aggregates in one response, created_at ASC', async () => {
    const body = await fetch(`${url}/api/home/workspaces`, { headers: authHeaders }).then((r) => r.json());
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([ws1, ws2, ws3]);

    const [item1, item2, item3] = body.items;

    // agent_count INCLUDES the per-workspace "brigadir" orchestrator that the
    // boot backfill seeds into every workspace (feature 010) — hence +1 each.
    // ws1: active, implementer + reviewer + brigadir, running last run, 1 failure in 24h.
    expect(item1).toMatchObject({
      project_key: 'BRIG',
      enabled: true,
      agent_count: 3,
      attention_24h: 1,
    });
    expect(item1.last_run).toMatchObject({ run_id: ws1LastRunId, status: 'running' });
    expect(item1.last_run.started_at).toBeTruthy();
    expect(item1.last_run.finished_at).toBeNull();

    // ws2: paused via settings.enabled=false; its 30h-old failure does NOT count.
    expect(item2).toMatchObject({ enabled: false, agent_count: 2, attention_24h: 0 });
    expect(item2.last_run.status).toBe('succeeded');

    // ws3: fresh — no runs, only the backfilled orchestrator; never an error.
    expect(item3).toMatchObject({
      name: 'fresh-ws',
      project_key: 'FRS',
      enabled: true,
      agent_count: 1,
      last_run: null,
      attention_24h: 0,
    });
  });

  it('requires the dashboard bearer (401)', async () => {
    expect((await fetch(`${url}/api/home/workspaces`)).status).toBe(401);
  });
});

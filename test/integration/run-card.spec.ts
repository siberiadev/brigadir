import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T027 (US2, FR-007..FR-011): GET run — run/ticket/checks (4 states ordered by
 * position)/events (chronological)/history; failure `error` present; partial
 * report → `checks: []`; unknown id → 404.
 */
describe('run card read model (T027)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let p: Awaited<ReturnType<typeof seedPipeline>>;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    p = await seedPipeline(db.db, { ticketKey: 'BRIG-42' });

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

  const insertRun = async (over: Record<string, unknown> = {}) => {
    const [r] = await db.db
      .insert(schema.runs)
      .values({ workspaceId: p.workspaceId, ticketId: p.ticketId, agentId: p.agentId, executorType: 'mock', status: 'succeeded', attempt: 1, ...over })
      .returning({ id: schema.runs.id });
    return r.id;
  };

  const getCard = (id: string) => fetch(`${url}/api/runs/${id}`, { headers: authHeaders });

  it('returns the full card: run, ticket, ordered checks (4 glyph states), chronological events, history', async () => {
    const runId = await insertRun({
      status: 'failed', outcome: 'failure', error: 'stderr diagnostics here',
      startedAt: new Date('2026-07-12T10:00:00.000Z'), finishedAt: new Date('2026-07-12T10:00:42.000Z'), costUsd: '0.1100',
    });
    // checks inserted out of order → must come back ordered by position
    await db.db.insert(schema.runChecks).values([
      { runId, position: 2, name: 'lint', status: 'warn', reason: 'style' },
      { runId, position: 0, name: 'tests', status: 'pass', reason: null },
      { runId, position: 1, name: 'build', status: 'fail', reason: 'broke' },
      { runId, position: 3, name: 'e2e', status: 'skip', reason: null },
    ]);
    await db.db.insert(schema.runEvents).values([
      { runId, type: 'progress', payload: { step: 'a' } },
      { runId, type: 'tool_call', payload: { tool: 'b' } },
    ]);

    const res = await getCard(runId);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.run.status).toBe('failed');
    expect(body.run.error).toBe('stderr diagnostics here'); // FR-011 failure diagnostics
    expect(body.run.duration_ms).toBe(42000);
    expect(body.run.cost_usd).toBe('0.1100');
    expect(body.ticket.key).toBe('BRIG-42');
    expect(body.ticket.jira_url).toContain('/browse/BRIG-42');

    expect(body.checks.map((c: { status: string }) => c.status)).toEqual(['pass', 'fail', 'warn', 'skip']);
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(['progress', 'tool_call']);
    expect(typeof body.events[0].id).toBe('string');
    expect(body.history.length).toBeGreaterThanOrEqual(1);
    expect(body.history[0].run_id).toBe(runId);
  });

  it('a run with no checks → checks: [] (partial report renders without error)', async () => {
    const runId = await insertRun({ status: 'running' });
    const body = await (await getCard(runId)).json();
    expect(body.checks).toEqual([]);
    expect(body.run.duration_ms).toBeNull(); // not started
  });

  it('unknown id → 404 run_not_found', async () => {
    const res = await getCard(randomUUID());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('run_not_found');
  });
});

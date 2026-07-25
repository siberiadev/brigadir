import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * GET /api/workspaces/:id/tickets/:key/history — the ticket-history page read
 * model: chronological runs with causal trigger refs, failed checks, routing
 * verdicts, linked human tasks, and the aggregates line. Addressed by
 * (workspace, jira_key); 404 for an unknown key or a foreign workspace.
 */
describe('ticket history read model', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let p: Awaited<ReturnType<typeof seedPipeline>>;
  let orchestratorId: string;

  const authHeaders = { authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    p = await seedPipeline(db.db, { ticketKey: 'BRIG-77' });

    // A second, orchestrator agent for the triage run of the rework cycle.
    const [orch] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId: p.workspaceId,
        executorId: p.executorId,
        name: 'Brigadir',
        key: 'brigadir',
        instruction: 'Triage failed runs.',
        statusSuccess: '—',
        statusFailure: '—',
        isOrchestrator: true,
      })
      .returning({ id: schema.agents.id });
    orchestratorId = orch.id;

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

  const getHistory = (wsId: string, key: string) =>
    fetch(`${url}/api/workspaces/${wsId}/tickets/${key}/history`, { headers: authHeaders });

  const insertRun = async (over: Record<string, unknown> = {}) => {
    const [r] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'succeeded',
        attempt: 1,
        ...over,
      })
      .returning({ id: schema.runs.id });
    return r.id;
  };

  it('returns the full chain: order, trigger refs, failed checks, routing, human tasks, aggregates', async () => {
    // dev pass → QA fail (with fail checks) → triage (routed) → rework → QA pass
    const devId = await insertRun({
      createdAt: new Date('2026-07-24T13:00:00.000Z'),
      startedAt: new Date('2026-07-24T13:00:05.000Z'),
      finishedAt: new Date('2026-07-24T13:10:05.000Z'),
      costUsd: '1.0000',
      outcome: 'success',
      triggerEvent: { source: 'poll' },
      report: { outcome: 'success', summary: 'Implemented, PR #1.' },
    });
    const qaFailId = await insertRun({
      createdAt: new Date('2026-07-24T13:11:00.000Z'),
      status: 'failed',
      outcome: 'failure',
      costUsd: '0.5000',
      triggerEvent: { source: 'poll' },
      report: { outcome: 'failure', summary: 'Lint errors found.' },
    });
    await db.db.insert(schema.runChecks).values([
      { runId: qaFailId, position: 0, name: 'tests', status: 'pass', reason: null },
      { runId: qaFailId, position: 1, name: 'lint', status: 'fail', reason: '3 unused imports' },
      { runId: qaFailId, position: 2, name: 'e2e', status: 'fail', reason: null },
    ]);
    const triageId = await insertRun({
      agentId: orchestratorId,
      createdAt: new Date('2026-07-24T13:12:00.000Z'),
      outcome: 'routed',
      triggerEvent: { source: 'triage', failing_run_id: qaFailId },
      report: {
        outcome: 'routed',
        summary: 'Defects confirmed — routing back to the developer.',
        routing: { target_agent: 'implementer', task: 'Fix the lint errors on the same branch.' },
      },
    });
    const reworkId = await insertRun({
      createdAt: new Date('2026-07-24T13:20:00.000Z'),
      outcome: 'success',
      costUsd: '0.2500',
      triggerEvent: {
        source: 'rework',
        failing_run_id: qaFailId,
        deciding_run_id: triageId,
        target_agent: 'implementer',
        task: 'Fix the lint errors on the same branch.',
      },
      report: { outcome: 'success', summary: 'Fixed.' },
    });
    const qaPassId = await insertRun({
      createdAt: new Date('2026-07-24T13:30:00.000Z'),
      finishedAt: new Date('2026-07-24T13:35:00.000Z'),
      startedAt: new Date('2026-07-24T13:30:10.000Z'),
      outcome: 'success',
      triggerEvent: { source: 'poll' },
      report: { outcome: 'success', summary: 'All green.' },
    });
    await db.db.insert(schema.humanTasks).values({
      workspaceId: p.workspaceId,
      runId: reworkId,
      ticketId: p.ticketId,
      kind: 'question',
      title: 'Which formatter?',
      status: 'resolved',
      resolution: 'prettier',
    });

    const res = await getHistory(p.workspaceId, 'BRIG-77');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ticket.key).toBe('BRIG-77');
    expect(body.ticket.jira_url).toContain('/browse/BRIG-77');
    expect(body.workspace.id).toBe(p.workspaceId);

    // Chronological order.
    expect(body.runs.map((r: { run_id: string }) => r.run_id)).toEqual([
      devId,
      qaFailId,
      triageId,
      reworkId,
      qaPassId,
    ]);

    // Causal trigger refs survive the projection.
    const triage = body.runs[2];
    expect(triage.agent.is_orchestrator).toBe(true);
    expect(triage.trigger.source).toBe('triage');
    expect(triage.trigger.failing_run_id).toBe(qaFailId);
    expect(triage.routing).toEqual({
      target_agent: 'implementer',
      task: 'Fix the lint errors on the same branch.',
    });

    const rework = body.runs[3];
    expect(rework.trigger.source).toBe('rework');
    expect(rework.trigger.deciding_run_id).toBe(triageId);
    expect(rework.human_tasks).toEqual([
      { id: expect.any(String), kind: 'question', title: 'Which formatter?', status: 'resolved' },
    ]);

    // Only the FAILED checks come back (pass rows are noise here).
    expect(body.runs[1].failed_checks).toEqual([
      { name: 'lint', reason: '3 unused imports' },
      { name: 'e2e', reason: null },
    ]);
    expect(body.runs[0].failed_checks).toEqual([]);
    expect(body.runs[0].summary).toBe('Implemented, PR #1.');
    expect(body.runs[0].duration_ms).toBe(600000);

    // Aggregates: 5 runs, 1 rework, SQL-summed cost (1.0 + 0.5 + 0.25).
    expect(body.aggregates.runs_total).toBe(5);
    expect(body.aggregates.rework_cycles).toBe(1);
    expect(Number(body.aggregates.total_cost_usd)).toBeCloseTo(1.75);
    expect(body.aggregates.first_run_at).toBe('2026-07-24T13:00:00.000Z');
    expect(body.aggregates.last_finished_at).toBe('2026-07-24T13:35:00.000Z');
  });

  it('a ticket with no runs → empty runs, null-ish aggregates', async () => {
    const [t2] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: p.workspaceId, jiraKey: 'BRIG-78', jiraId: '10002', summary: 'Untouched' })
      .returning({ id: schema.tickets.id });
    expect(t2.id).toBeTruthy();

    const body = await (await getHistory(p.workspaceId, 'BRIG-78')).json();
    expect(body.runs).toEqual([]);
    expect(body.aggregates).toEqual({
      runs_total: 0,
      rework_cycles: 0,
      total_cost_usd: null,
      first_run_at: null,
      last_finished_at: null,
    });
  });

  it('unknown key → 404 ticket_not_found; the key is workspace-scoped', async () => {
    const res = await getHistory(p.workspaceId, 'BRIG-9999');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('ticket_not_found');

    // Same key, FOREIGN workspace → also 404 (no cross-workspace leak).
    const other = await seedPipeline(db.db, { ticketKey: 'OTHER-1' });
    const res2 = await getHistory(other.workspaceId, 'BRIG-77');
    expect(res2.status).toBe(404);
  });
});

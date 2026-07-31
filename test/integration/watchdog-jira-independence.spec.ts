import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { ReconcileService } from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';
// Deliberately NOT any agent's trigger status — reconcile's poll step must not
// start runs while these tests exercise the watchdog.
const IDLE_STATUS = 'Backlog';

/**
 * Feature 034 (watchdog audit): the watchdog is a pure-DB reaper and must run
 * even when a workspace's Jira is broken or the workspace is disabled — the
 * 17h-Reviewer incident class. Also covers the new stale-`queued` sweep.
 */
describe('watchdog: Jira-independence + queued sweep (feature 034)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let counter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    reconcile = worker.get(ReconcileService, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(() => mock.reset());

  async function seedWorkspace(opts: {
    credentials: string;
    settings?: Record<string, unknown>;
  }): Promise<{ workspaceId: string; agentId: string }> {
    const [w] = await db.db
      .insert(schema.workspaces)
      .values({
        name: `ws-${++counter}`,
        jiraSiteUrl: BASE,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: opts.credentials,
        ...(opts.settings ? { settings: opts.settings } : {}),
      })
      .returning({ id: schema.workspaces.id });
    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: `mock-exec-${counter}`, maxParallelRuns: 2 })
      .returning({ id: schema.executors.id });
    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId: w.id,
        executorId: exec.id,
        name: 'impl',
        key: 'impl',
        instruction: 'do it',
        triggerStatus: 'Ready for Dev',
        statusRunning: null,
        statusSuccess: 'Code Review',
        statusFailure: 'Blocked',
        timeoutMinutes: 1,
        behavior: {},
        maxAttempts: 2,
      })
      .returning({ id: schema.agents.id });
    return { workspaceId: w.id, agentId: agent.id };
  }

  async function seedTicket(workspaceId: string): Promise<{ ticketId: string; key: string }> {
    const key = `BRIG-9${++counter}`;
    mock.seedIssue(key, { status: IDLE_STATUS });
    const [t] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId, jiraKey: key, jiraId: '10000', summary: key, lastSeenStatus: IDLE_STATUS })
      .returning({ id: schema.tickets.id });
    return { ticketId: t.id, key };
  }

  async function statusOf(runId: string): Promise<{ status: string; error: string | null }> {
    const [r] = await db.db
      .select({ status: schema.runs.status, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    return r;
  }

  async function watchdogEventsFor(runId: string) {
    const rows = await db.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'log')));
    return rows
      .map((r) => r.payload as { source?: string; message?: string })
      .filter((p) => p.source === 'watchdog');
  }

  it('broken Jira credentials: the reconcile pass still sweeps the stale running run', async () => {
    const { workspaceId, agentId } = await seedWorkspace({
      credentials: 'not-a-valid-credentials-blob',
    });
    const { ticketId, key } = await seedTicket(workspaceId);
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId,
        agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
        startedAt: sql`now() - interval '30 minutes'`, // past timeout(1m)+grace(5m)
      })
      .returning({ id: schema.runs.id });

    // The ORCHESTRATION is under test: run() must reach the watchdog even
    // though this workspace's Jira client cannot be constructed at all.
    await expect(reconcile.run()).resolves.toBeUndefined();

    const after = await statusOf(run.id);
    expect(after.status).toBe('timed_out');
    expect(after.error).toContain('watchdog: exceeded timeout');
    const events = await watchdogEventsFor(run.id);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('force-finalized as timed_out');
    // No Jira write happened (client construction throws) — drift repair owns it.
    expect(mock.transitionsFor(key)).toEqual([]);
  });

  it('disabled workspace: the zombie running run is swept with ZERO Jira work', async () => {
    const { workspaceId, agentId } = await seedWorkspace({
      credentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      settings: { enabled: false },
    });
    const { ticketId, key } = await seedTicket(workspaceId);
    const [run] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId,
        agentId,
        executorType: 'mock',
        status: 'running',
        attempt: 1,
        startedAt: sql`now() - interval '30 minutes'`,
      })
      .returning({ id: schema.runs.id });

    await reconcile.run();

    const after = await statusOf(run.id);
    expect(after.status).toBe('timed_out');
    expect(await watchdogEventsFor(run.id)).toHaveLength(1);
    // FR-028: disabled ⇒ no Jira work — not even the failure treatment.
    expect(mock.transitionsFor(key)).toEqual([]);
    expect(mock.commentsFor(key)).toHaveLength(0);
  });

  it('queued sweep: a run stuck in queued past the threshold → failed (+Jira failure treatment); a fresh one is untouched', async () => {
    const { workspaceId, agentId } = await seedWorkspace({
      credentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });
    const stale = await seedTicket(workspaceId);
    const fresh = await seedTicket(workspaceId);
    const [staleRun] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: stale.ticketId,
        agentId,
        executorType: 'mock',
        status: 'queued',
        attempt: 1,
        createdAt: sql`now() - interval '13 hours'`, // past the 720m default
      })
      .returning({ id: schema.runs.id });
    const [freshRun] = await db.db
      .insert(schema.runs)
      .values({
        workspaceId,
        ticketId: fresh.ticketId,
        agentId,
        executorType: 'mock',
        status: 'queued',
        attempt: 1,
        createdAt: sql`now() - interval '1 hour'`,
      })
      .returning({ id: schema.runs.id });

    await reconcile.run();

    const after = await statusOf(staleRun.id);
    expect(after.status).toBe('failed');
    expect(after.error).toContain('stuck in queued');
    const events = await watchdogEventsFor(staleRun.id);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('finalized as failed');
    // Enabled workspace with working Jira → the failure treatment applies.
    expect(mock.transitionsFor(stale.key)).toEqual(['Blocked']);

    // The fresh queued run is untouched, and no duplicate run appeared.
    expect((await statusOf(freshRun.id)).status).toBe('queued');
    const staleTicketRuns = await db.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.ticketId, stale.ticketId));
    expect(staleTicketRuns).toHaveLength(1);
  });
});

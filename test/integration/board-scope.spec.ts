import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { ReconcileService, type WorkspaceContext } from '@brigadir/ingest';
import type { JiraBoardType } from '@brigadir/contracts';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock.atlassian.net';
const TRIGGER = 'Ready for Dev';
const NOOP_SCHEDULER = { onApplicationBootstrap: async () => {} };

interface Booted {
  db: DbHarness;
  redis: RedisHarness;
  mock: MockJira;
  worker: TestingModule;
  reconcile: ReconcileService;
  ws: WorkspaceContext;
  agentId: string;
}

async function boot(boardType: JiraBoardType): Promise<Booted> {
  const db = await startDatabase();
  const redis = await startRedis();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = redis.url;
  process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

  const mock = mockJira({ baseUrl: BASE, boardType, projectKey: 'BRIG' });
  mock.server.listen({ onUnhandledRequest: 'bypass' });

  const [ws] = await db.db
    .insert(schema.workspaces)
    .values({
      name: 'ws',
      jiraSiteUrl: BASE,
      jiraProjectKey: 'BRIG',
      jiraBoardId: 42,
      jiraBoardType: boardType,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    })
    .returning({ id: schema.workspaces.id });
  const [exec] = await db.db
    .insert(schema.executors)
    .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 2 })
    .returning({ id: schema.executors.id });
  const [agent] = await db.db
    .insert(schema.agents)
    .values({
      workspaceId: ws.id,
      executorId: exec.id,
      name: 'impl',
      key: 'impl',
      instruction: 'do it',
      triggerStatus: TRIGGER,
      statusSuccess: 'Code Review',
      statusFailure: 'Blocked',
      behavior: { mock_scenario: 'success' },
      maxAttempts: 2,
    })
    .returning({ id: schema.agents.id });

  const worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
    .overrideProvider(ReconcileScheduler)
    .useValue(NOOP_SCHEDULER)
    .compile();
  await worker.init();
  await worker.get(RunProcessor).worker.waitUntilReady();

  return {
    db,
    redis,
    mock,
    worker,
    reconcile: worker.get(ReconcileService, { strict: false }),
    ws: { id: ws.id, projectKey: 'BRIG', boardId: 42, boardType },
    agentId: agent.id,
  };
}

async function teardown(b: Booted): Promise<void> {
  await b.worker?.close();
  b.mock?.server.close();
  await b.db?.stop();
  await b.redis?.stop();
}

async function runCount(b: Booted): Promise<number> {
  const rows = await b.db.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.agentId, b.agentId));
  return rows.length;
}

/**
 * T065 (US6): board-type-aware ingest scope (FR-029–FR-032; SC-009).
 *  - scrum, no active sprint → idle (no triggers);
 *  - a ticket already in a trigger status when the sprint starts → fires once
 *    (dedup holds on a repeat pass);
 *  - a sprint switch full rescan picks up in-status issues whose `updated`
 *    never changed;
 *  - kanban → whole-project behavior unchanged.
 */
describe('board scope: scrum sprint semantics (T065)', () => {
  let b: Booted;

  beforeAll(async () => {
    b = await boot('scrum');
    // Two tickets already sitting in the trigger status; not yet in any sprint.
    b.mock.seedIssue('BRIG-1', { status: TRIGGER });
    b.mock.seedIssue('BRIG-2', { status: TRIGGER, updated: '2026-01-01T00:00:00.000Z' });
  }, 240_000);

  afterAll(async () => teardown(b));

  it('no active sprint → idle, no triggers (FR-030)', async () => {
    await b.reconcile.run();
    expect(await runCount(b)).toBe(0);
  });

  it('ticket in a trigger status when the sprint starts → fires exactly once (FR-031)', async () => {
    b.mock.startSprint(100, ['BRIG-1']);
    await b.reconcile.run();
    expect(await runCount(b)).toBe(1);

    // Repeat pass: dedup + diff cache → no additional run.
    await b.reconcile.run();
    expect(await runCount(b)).toBe(1);
  });

  it('sprint switch → full rescan picks up in-status issues whose updated never changed (FR-032)', async () => {
    // BRIG-2 has an ancient `updated`; adding it to a NEW sprint does not touch it.
    b.mock.startSprint(200, ['BRIG-2']);
    await b.reconcile.run();
    expect(await runCount(b)).toBe(2); // BRIG-2 surfaced by the update-independent rescan

    const runs = await b.db.db
      .select({ ticketId: schema.runs.ticketId })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, b.agentId));
    const [brig2] = await b.db.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.jiraKey, 'BRIG-2'));
    expect(runs.map((r) => r.ticketId)).toContain(brig2.id);
  });
});

describe('board scope: multiple active sprints (FR-032)', () => {
  let b: Booted;

  beforeAll(async () => {
    b = await boot('scrum');
    b.mock.seedIssue('BRIG-1', { status: TRIGGER });
    b.mock.seedIssue('BRIG-2', { status: TRIGGER });
  }, 240_000);

  afterAll(async () => teardown(b));

  it('scopes over the whole active set — a ticket in ANY active sprint triggers', async () => {
    // Two sprints active at once (a board may run several in parallel).
    b.mock.startSprint(100, ['BRIG-1']);
    b.mock.addActiveSprint(200, ['BRIG-2']);
    await b.reconcile.run();
    expect(await runCount(b)).toBe(2); // both surfaced by `sprint in (100,200)`

    // Repeat pass: set unchanged → dedup + diff cache → no additional run.
    await b.reconcile.run();
    expect(await runCount(b)).toBe(2);
  });
});

describe('board scope: kanban whole-project unchanged (T065)', () => {
  let b: Booted;

  beforeAll(async () => {
    b = await boot('kanban');
    b.mock.seedIssue('BRIG-1', { status: TRIGGER });
    b.mock.seedIssue('BRIG-2', { status: 'Backlog' }); // not in a trigger status
  }, 240_000);

  afterAll(async () => teardown(b));

  it('polls the whole project and triggers only the trigger-status ticket', async () => {
    await b.reconcile.run();
    expect(await runCount(b)).toBe(1); // only BRIG-1

    await b.reconcile.run();
    expect(await runCount(b)).toBe(1);
  });
});

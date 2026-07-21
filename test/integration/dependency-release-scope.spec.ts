import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials, JiraClientFactory, type JiraClient } from '@brigadir/jira';
import { DependencyReleaseService } from '@brigadir/pipeline';
import { ReconcileService, type WorkspaceContext } from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import { join } from 'node:path';

const BASE = 'https://mock-scope-release.atlassian.net';
const TRIGGER = 'Ready for Dev';
const SCOPE_JQL = 'labels = in-scope';
const NOOP_SCHEDULER = { onApplicationBootstrap: async () => {} };

interface Booted {
  db: DbHarness;
  redis: RedisHarness;
  mock: MockJira;
  worker: TestingModule;
  reconcile: ReconcileService;
  dependencyRelease: DependencyReleaseService;
  jira: JiraClient;
  ws: WorkspaceContext;
  workspaceId: string;
  agentId: string;
}

async function boot(): Promise<Booted> {
  const db = await startDatabase();
  const redis = await startRedis();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = redis.url;
  process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');

  const mock = mockJira({ baseUrl: BASE, boardType: 'scrum', projectKey: 'BRIG' });
  mock.server.listen({ onUnhandledRequest: 'bypass' });

  const [ws] = await db.db
    .insert(schema.workspaces)
    .values({
      name: 'ws-scope-release',
      jiraSiteUrl: BASE,
      jiraProjectKey: 'BRIG',
      jiraBoardId: 42,
      jiraBoardType: 'scrum',
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      settings: { scope_jql: SCOPE_JQL },
    })
    .returning({ id: schema.workspaces.id });
  const [exec] = await db.db
    .insert(schema.executors)
    .values({ type: 'mock', name: 'mock-exec-scope-release', maxParallelRuns: 2 })
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

  const jira = await worker.get(JiraClientFactory, { strict: false }).forWorkspace(ws.id);

  return {
    db,
    redis,
    mock,
    worker,
    reconcile: worker.get(ReconcileService, { strict: false }),
    dependencyRelease: worker.get(DependencyReleaseService, { strict: false }),
    jira,
    ws: { id: ws.id, projectKey: 'BRIG', boardId: 42, boardType: 'scrum' },
    workspaceId: ws.id,
    agentId: agent.id,
  };
}

async function teardown(b: Booted): Promise<void> {
  await b.worker?.close();
  b.mock?.server.close();
  await b.db?.stop();
  await b.redis?.stop();
}

/** Seed a ticket straight into the local cache, bypassing the poller — the
 * precondition this bug needs: a candidate already sitting in a trigger
 * status that scope_jql would exclude if it were re-queried through Jira. */
async function seedTicket(
  b: Booted,
  key: string,
  status: string,
  blockedBy?: string[],
): Promise<string> {
  const [t] = await b.db.db
    .insert(schema.tickets)
    .values({
      workspaceId: b.workspaceId,
      jiraKey: key,
      jiraId: '10000',
      summary: key,
      lastSeenStatus: status,
      blockedBy,
    })
    .returning({ id: schema.tickets.id });
  return t.id;
}

async function runsForAgent(b: Booted): Promise<{ ticketId: string }[]> {
  return b.db.db
    .select({ ticketId: schema.runs.ticketId })
    .from(schema.runs)
    .where(eq(schema.runs.agentId, b.agentId));
}

async function ticketIdOf(b: Booted, key: string): Promise<string> {
  const [row] = await b.db.db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(eq(schema.tickets.jiraKey, key));
  return row.id;
}

/**
 * Regression coverage for the live incident: `scope_jql` is applied on the
 * poller/preview/blocker-classification paths but was silently ignored by
 * `DependencyReleaseService`'s release/trigger decision (FR-038 compliance
 * gap). A workspace with `scope_jql` pinning one sprint, on a board running
 * two active sprints at once, must only release the in-scope ticket even
 * though both sit in the local cache in a trigger status.
 */
describe('dependency release respects scope_jql (multi-active-sprint live incident)', () => {
  let b: Booted;
  const KEY_IN = 'BRIG-201';
  const KEY_OUT = 'BRIG-202';

  beforeAll(async () => {
    b = await boot();
    b.mock.seedIssue(KEY_IN, { status: TRIGGER, labels: ['in-scope'] });
    b.mock.seedIssue(KEY_OUT, { status: TRIGGER });
    // Two sprints simultaneously active on the board — the live incident's precondition.
    b.mock.startSprint(100, [KEY_IN]);
    b.mock.addActiveSprint(200, [KEY_OUT]);
    // Both tickets already cached in the trigger status (candidates() has no
    // Jira awareness — this is exactly how a ticket that drifted out of scope
    // stays a "candidate" until the release re-fetch is itself scope-filtered).
    await seedTicket(b, KEY_IN, TRIGGER);
    await seedTicket(b, KEY_OUT, TRIGGER);
  }, 240_000);

  afterAll(async () => teardown(b));

  it('only the in-scope ticket releases; the out-of-scope one never triggers (FR-038)', async () => {
    await b.reconcile.reEvaluateDependencies(b.ws, b.jira);
    const runs = await runsForAgent(b);
    expect(runs).toHaveLength(1);
    expect(runs[0].ticketId).toBe(await ticketIdOf(b, KEY_IN));

    // Repeat pass: no duplicate, and the out-of-scope ticket still never releases.
    await b.reconcile.reEvaluateDependencies(b.ws, b.jira);
    expect(await runsForAgent(b)).toHaveLength(1);
  });
});

describe('dependency release fast path (releaseDependentsOf) respects scope_jql', () => {
  let b: Booted;
  const KEY_BLOCKER = 'BRIG-301';
  const KEY_DEP_IN = 'BRIG-302';
  const KEY_DEP_OUT = 'BRIG-303';

  beforeAll(async () => {
    b = await boot();
    b.mock.seedIssue(KEY_BLOCKER, { status: 'Done', labels: ['in-scope'] });
    b.mock.seedIssue(KEY_DEP_IN, { status: TRIGGER, labels: ['in-scope'] });
    b.mock.seedIssue(KEY_DEP_OUT, { status: TRIGGER });
    b.mock.addBlockedByLink(KEY_DEP_IN, KEY_BLOCKER);
    b.mock.addBlockedByLink(KEY_DEP_OUT, KEY_BLOCKER);
    b.mock.startSprint(100, [KEY_BLOCKER, KEY_DEP_IN]);
    b.mock.addActiveSprint(200, [KEY_DEP_OUT]);
    await seedTicket(b, KEY_DEP_IN, TRIGGER, [KEY_BLOCKER]);
    await seedTicket(b, KEY_DEP_OUT, TRIGGER, [KEY_BLOCKER]);
  }, 240_000);

  afterAll(async () => teardown(b));

  it('the fast path releases only the in-scope dependent', async () => {
    await b.dependencyRelease.releaseDependentsOf(b.ws, b.jira, KEY_BLOCKER);
    const runs = await runsForAgent(b);
    expect(runs).toHaveLength(1);
    expect(runs[0].ticketId).toBe(await ticketIdOf(b, KEY_DEP_IN));
  });
});

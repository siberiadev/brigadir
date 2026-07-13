import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials, JiraClientFactory, type JiraClient } from '@brigadir/jira';
import { ReconcileService, PollerService, type WorkspaceContext } from '@brigadir/ingest';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { join } from 'node:path';

/**
 * T020 (US5, FR-027/FR-026): each enabled workspace is polled with ITS OWN Jira
 * client (resolved by `JiraClientFactory.forWorkspace(ws.id)`) and its own board
 * scope (projectKey). A call for workspace B uses B's client, not A's.
 */
describe('multi-workspace reconcile: per-workspace client + scope (T020)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let worker: TestingModule;
  let reconcile: ReconcileService;
  let factory: JiraClientFactory;
  let poller: PollerService;
  let wsA: string;
  let wsB: string;

  const insertWs = async (name: string, projectKey: string) => {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name,
        jiraSiteUrl: `https://${name}.atlassian.net`,
        jiraProjectKey: projectKey,
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: encodeJiraCredentials({ email: `${name}@acme.io`, api_token: `tok-${name}` }),
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    wsA = await insertWs('a', 'AAA');
    wsB = await insertWs('b', 'BBB');

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    reconcile = worker.get(ReconcileService, { strict: false });
    factory = worker.get(JiraClientFactory, { strict: false });
    poller = worker.get(PollerService, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('threads each workspace its own client and its own board scope into the poll', async () => {
    // Sentinel clients per workspace id — proves the poll receives the client
    // resolved for THAT workspace (never a shared/global one).
    const clientA = { tag: 'A' } as unknown as JiraClient;
    const clientB = { tag: 'B' } as unknown as JiraClient;
    const forWs = vi
      .spyOn(factory, 'forWorkspace')
      .mockImplementation((id: string) => Promise.resolve(id === wsA ? clientA : clientB));

    // Capture (ws, jira) per poll; no real Jira I/O.
    const calls: Array<{ ws: WorkspaceContext; jira: JiraClient }> = [];
    const poll = vi
      .spyOn(poller, 'pollAndDiff')
      .mockImplementation(async (ws: WorkspaceContext, jira: JiraClient) => {
        calls.push({ ws, jira });
      });

    await reconcile.run();

    // per-workspace client resolution
    expect(forWs).toHaveBeenCalledWith(wsA);
    expect(forWs).toHaveBeenCalledWith(wsB);

    const callA = calls.find((c) => c.ws.id === wsA);
    const callB = calls.find((c) => c.ws.id === wsB);
    expect(callA?.jira).toBe(clientA); // A polled with A's client
    expect(callB?.jira).toBe(clientB); // B polled with B's client
    // per-workspace board scope preserved (FR-026)
    expect(callA?.ws.projectKey).toBe('AAA');
    expect(callB?.ws.projectKey).toBe('BBB');

    poll.mockRestore();
    forWs.mockRestore();
  });
});

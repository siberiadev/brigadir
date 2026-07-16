import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { createToolHandlers, type AdminToolHandlers } from '../../packages/admin-mcp/src/tools';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const GOOD = { email: 'bot@acme.com', token: 'good-token' };

/**
 * Feature 012 — the `brigadir-admin` admin MCP driven end-to-end against the REAL
 * dashboard API (BackendAppModule + mock Jira). Asserts the invariants that make
 * the admin plane safe: create_workspace lands a PAUSED workspace (enabled=false);
 * create_team is atomic (an invalid agent mid-list ⇒ 422 and ZERO created) and
 * refuses a second team (worker_agents_exist); generate_agents returns 202 and
 * then 409. The tool handlers are exercised through their public `fetchImpl`
 * pointed at the backend (a stand-in for the stdio transport).
 */
describe('brigadir-admin against the real backend (feature 012)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let backend: INestApplication;
  let jira: MockJira;
  let handlers: AdminToolHandlers;
  let mockProfileName: string;
  let wsCounter = 0;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });
    jira.expectAuth(GOOD.email, GOOD.token);

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = moduleRef.createNestApplication();
    await backend.init();
    await backend.listen(0);
    const url = await backend.getUrl();

    handlers = createToolHandlers({
      apiUrl: url,
      dashboardToken: TEST_DASHBOARD_TOKEN,
      jiraEmail: GOOD.email,
      jiraApiToken: GOOD.token,
      retryDelayMs: () => 0,
    });

    // The proposal references an executor profile by NAME — one enabled mock
    // profile serves every create_team in this suite.
    mockProfileName = `mock-admin-${randomBytes(3).toString('hex')}`;
    await db.db.insert(schema.executors).values({ type: 'mock', name: mockProfileName, maxParallelRuns: 4 });
  }, 240_000);

  afterAll(async () => {
    jira?.server.close();
    await backend?.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(() => {
    jira.reset();
    jira.expectAuth(GOOD.email, GOOD.token);
  });

  /** Create a paused workspace through the tool, returning its id. */
  async function createWorkspace(): Promise<string> {
    const res = await handlers.create_workspace({
      name: `admin-ws-${++wsCounter}`,
      jira_site_url: jira.baseUrl,
      board: '42',
      expires_at: '2027-07-12T00:00:00.000Z',
    });
    expect(res.isError, JSON.stringify(res.content)).toBeUndefined();
    return res.structuredContent!.workspace_id as string;
  }

  const workerAgents = (workspaceId: string) =>
    db.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.isOrchestrator, false)));

  const validRoster = () => [
    {
      name: 'Developer',
      description: 'Implements tickets end to end and opens a PR.',
      instruction: 'You are Developer. Implement the ticket and open a PR.',
      trigger_status: 'Ready for Dev',
      status_running: 'In Progress',
      status_success: 'Code Review',
      status_failure: 'Blocked',
      executor: mockProfileName,
    },
    {
      name: 'Reviewer',
      description: 'Reviews PRs against the ticket requirements.',
      instruction: 'You are Reviewer. Review the PR rigorously.',
      trigger_status: 'Code Review',
      status_success: 'Done',
      status_failure: 'Blocked',
      executor: mockProfileName,
    },
  ];

  it('create_workspace lands a PAUSED workspace (enabled=false)', async () => {
    const res = await handlers.create_workspace({
      name: `admin-ws-${++wsCounter}`,
      jira_site_url: jira.baseUrl,
      board: '42',
      expires_at: '2027-07-12T00:00:00.000Z',
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ project_key: 'BRIG', board_type: 'kanban', enabled: false });

    // The row exists and is paused; its only agent is the seeded orchestrator.
    const id = res.structuredContent!.workspace_id as string;
    const detail = await handlers.get_workspace({ workspace_id: id });
    expect(detail.structuredContent!.enabled).toBe(false);
    expect(await workerAgents(id)).toHaveLength(0);
  });

  it('get_board_statuses surfaces the live board status names, bypassing the cache', async () => {
    const id = await createWorkspace();
    const res = await handlers.get_board_statuses({ workspace_id: id });
    expect(res.isError).toBeUndefined();
    const names = (res.structuredContent!.statuses as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['Ready for Dev', 'Code Review', 'Blocked', 'Done']));

    // LIVE means live: a status added to the board after the first fetch must
    // show up immediately — the tool's refresh=true bypasses the backend's
    // 5-minute StatusesService cache (a wrong param value, e.g. refresh=1, is
    // silently treated as false and would serve the stale list).
    jira.setCategory('QA Review', 'indeterminate');
    const second = await handlers.get_board_statuses({ workspace_id: id });
    expect(second.isError).toBeUndefined();
    const secondNames = (second.structuredContent!.statuses as { name: string }[]).map((s) => s.name);
    expect(secondNames).toContain('QA Review');
  });

  it('create_team spawns the whole roster atomically (enabled worker agents)', async () => {
    const id = await createWorkspace();
    const res = await handlers.create_team({ workspace_id: id, agents: validRoster() });
    expect(res.isError, JSON.stringify(res.content)).toBeUndefined();
    expect(res.structuredContent).toEqual({ workspace_id: id, agents_created: 2 });

    const agents = await workerAgents(id);
    expect(agents.map((a) => a.name).sort()).toEqual(['Developer', 'Reviewer']);
    for (const a of agents) {
      expect(a.enabled).toBe(true);
      expect(a.isOrchestrator).toBe(false);
    }
    const dev = agents.find((a) => a.name === 'Developer')!;
    expect(dev.triggerStatus).toBe('Ready for Dev');
    expect(dev.statusRunning).toBe('In Progress');
  });

  it('an invalid agent mid-roster ⇒ 422 with path-qualified issues and ZERO created', async () => {
    const id = await createWorkspace();
    const roster = validRoster();
    roster[1] = { ...roster[1], trigger_status: 'Nonexistent Status' };

    const res = await handlers.create_team({ workspace_id: id, agents: roster });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text) as { error: { code: string; issues: { path: (string | number)[]; code: string }[] } };
    expect(body.error.code).toBe('validation_failed');
    // The issue is path-qualified to the offending agent index.
    expect(body.error.issues.some((i) => i.path.includes(1))).toBe(true);
    // Atomic: nothing was created.
    expect(await workerAgents(id)).toHaveLength(0);
  });

  it('create_team refuses a second team once worker agents exist (worker_agents_exist)', async () => {
    const id = await createWorkspace();
    const first = await handlers.create_team({ workspace_id: id, agents: validRoster() });
    expect(first.isError).toBeUndefined();

    const second = await handlers.create_team({
      workspace_id: id,
      agents: [{ ...validRoster()[0], name: 'Another', trigger_status: 'Backlog' }],
    });
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text).error.code).toBe('worker_agents_exist');
    expect(await workerAgents(id)).toHaveLength(2);
  });

  it('generate_agents returns 202 run_id, then 409 while the setup run is active', async () => {
    const id = await createWorkspace();
    const first = await handlers.generate_agents({ workspace_id: id });
    expect(first.isError, JSON.stringify(first.content)).toBeUndefined();
    expect(typeof first.structuredContent!.run_id).toBe('string');

    // No worker consumes the queued setup run in this suite, so it stays active.
    const second = await handlers.generate_agents({ workspace_id: id });
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text).error.code).toBe('setup_run_active');
  });

  it('list_workspaces and list_executors flatten pagination', async () => {
    await createWorkspace();
    const ws = await handlers.list_workspaces({});
    expect(ws.isError).toBeUndefined();
    expect((ws.structuredContent!.items as unknown[]).length).toBeGreaterThan(0);

    const ex = await handlers.list_executors({});
    expect(ex.isError).toBeUndefined();
    const names = (ex.structuredContent!.items as { name: string }[]).map((e) => e.name);
    expect(names).toContain(mockProfileName);
  });
});

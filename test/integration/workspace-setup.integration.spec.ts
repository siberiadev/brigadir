import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { schema, ORCHESTRATOR_AGENT_NAME } from '@brigadir/database';
import { PipelineService } from '@brigadir/pipeline';
import { RunTriggerService } from '@brigadir/runs';
import { MockExecutor } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ReconcileScheduler } from '../../apps/worker/src/reconcile.scheduler';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const GOOD = { email: 'bot@acme.com', token: 'good-token' };

/**
 * Feature 011 — workspace setup by the orchestrator (quickstart Scenarios A/B/D):
 * create-paused wizard workspace → Generate agents → ticketless setup run →
 * `team` proposal → agents created enabled + ticketless review task, workspace
 * still paused; plus the guards: concurrent generate (one active setup run),
 * invalid proposal (zero agents, fail-closed, human task, no triage), replay
 * idempotency, duplicate-name 422 (not a 500), resume of a parked setup run
 * as a new setup run (never answer-triage), and FR-014 (team from a worker
 * run recast as failure).
 */
describe('workspace setup by the orchestrator (feature 011)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let jira: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let url: string;
  let mockProfileName: string;
  let mockProfileId: string;
  let runSpy: ReturnType<typeof vi.spyOn>;
  let wsCounter = 0;

  const authHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${TEST_DASHBOARD_TOKEN}`,
  };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });
    jira.expectAuth(GOOD.email, GOOD.token);

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    url = await backend.getUrl();

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(ReconcileScheduler)
      .useValue({ onApplicationBootstrap: async () => {} })
      .compile();
    await worker.init();
    await worker.get(RunProcessor).worker.waitUntilReady();

    // The proposal references an executor profile by NAME — one enabled mock
    // profile serves every proposal in this suite.
    mockProfileName = `mock-team-${randomBytes(3).toString('hex')}`;
    const [profile] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: mockProfileName, maxParallelRuns: 4 })
      .returning({ id: schema.executors.id });
    mockProfileId = profile.id;

    const mockExecutor = worker.get(MockExecutor, { strict: false });
    runSpy = vi.spyOn(mockExecutor, 'run');
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    jira?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Wizard create (server re-verifies against the mock Jira). */
  async function createWorkspace(): Promise<{ id: string; enabled: boolean }> {
    const res = await fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `setup-ws-${++wsCounter}`,
        jira_site_url: jira.baseUrl,
        jira_email: GOOD.email,
        jira_api_token: GOOD.token,
        expires_at: '2027-07-12T00:00:00.000Z',
        board: '42',
        repositories: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; enabled: boolean };
    return body;
  }

  /** Re-point the seeded orchestrator at the mock profile with a test scenario. */
  async function armOrchestrator(
    workspaceId: string,
    behavior: Record<string, unknown>,
  ): Promise<string> {
    const [orch] = await db.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.name, ORCHESTRATOR_AGENT_NAME)),
      )
      .limit(1);
    await db.db
      .update(schema.agents)
      .set({ executorId: mockProfileId, behavior })
      .where(eq(schema.agents.id, orch.id));
    return orch.id;
  }

  const generate = (workspaceId: string) =>
    fetch(`${url}/api/workspaces/${workspaceId}/generate-agents`, { method: 'POST', headers: authHeaders });

  const setupRuns = (workspaceId: string) =>
    db.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.workspaceId, workspaceId), isNull(schema.runs.ticketId)));

  const workerAgents = (workspaceId: string) =>
    db.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.isOrchestrator, false)));

  const TEAM = [
    {
      name: 'Developer',
      // feature 014: model supplies name + role; the system derives the key.
      role: 'Developer',
      description: 'Implements tickets end to end and opens a PR.',
      instruction: 'You are Developer. Implement the ticket and open a PR.',
      trigger_status: 'Ready for Dev',
      status_running: 'In Progress',
      status_success: 'Code Review',
      status_failure: 'Blocked',
      executor: '__PROFILE__',
    },
    {
      name: 'Reviewer',
      role: 'QA',
      description: 'Reviews PRs against the ticket requirements.',
      instruction: 'You are Reviewer. Review the PR rigorously.',
      trigger_status: 'Code Review',
      status_success: 'Done',
      status_failure: 'Blocked',
      executor: '__PROFILE__',
    },
  ];

  function team(): typeof TEAM {
    return TEAM.map((a) => ({ ...a, executor: mockProfileName }));
  }

  it('Scenario A: create paused → generate → team applied + review task, workspace stays paused, single Start gate', async () => {
    const ws = await createWorkspace();
    // FR-001/D14: a new workspace comes into existence PAUSED.
    expect(ws.enabled).toBe(false);

    await armOrchestrator(ws.id, { mock_scenario: 'team', team_proposal: team() });

    const res = await generate(ws.id);
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    // The setup run is ticketless and workspace-setup-sourced.
    const [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, run_id));
    expect(run.ticketId).toBeNull();
    expect((run.triggerEvent as { source?: string }).source).toBe('workspace-setup');

    await waitFor(async () => {
      const [r] = await db.db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, run_id));
      return r?.status === 'succeeded';
    });

    // The setup handoff reached the agent's prompt (digest + protocol).
    const setupCall = runSpy.mock.calls.find(
      (c) => (c[0] as { runId: string }).runId === run_id,
    );
    expect(setupCall).toBeDefined();
    const ctx = setupCall![0] as { ticket: unknown; instruction: string };
    expect(ctx.ticket).toBeNull();
    expect(ctx.instruction).toContain('## Workspace setup');
    expect(ctx.instruction).toContain('BRIG');
    expect(ctx.instruction).toContain(mockProfileName);
    expect(ctx.instruction).toContain('get_project_overview');

    // FR-016: both agents exist, ENABLED, with the proposal's bindings.
    const agents = await workerAgents(ws.id);
    expect(agents.map((a) => a.name).sort()).toEqual(['Developer', 'Reviewer']);
    for (const a of agents) {
      expect(a.enabled).toBe(true);
      expect(a.executorId).toBe(mockProfileId);
      expect(a.isOrchestrator).toBe(false);
    }
    const dev = agents.find((a) => a.name === 'Developer')!;
    expect(dev.triggerStatus).toBe('Ready for Dev');
    expect(dev.statusRunning).toBe('In Progress');
    expect(dev.statusSuccess).toBe('Code Review');
    expect(dev.statusFailure).toBe('Blocked');
    expect(dev.description).toContain('Implements tickets');
    // feature 014: the system derived the key from name + role; role persisted.
    expect(dev.role).toBe('Developer');
    expect(dev.key).toBe('developer-developer'); // slug("Developer" + "Developer")
    expect(agents.find((a) => a.name === 'Reviewer')!.key).toBe('reviewer-qa');

    // One ticketless, non-blocking review task.
    const tasks = await db.db
      .select()
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.workspaceId, ws.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe('review');
    expect(tasks[0].blocking).toBe(false);
    expect(tasks[0].ticketId).toBeNull();
    expect(tasks[0].runId).toBe(run_id);

    // Completion marker (replay no-op guard) with the setup decision.
    const events = await db.db
      .select()
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, run_id), eq(schema.runEvents.type, 'jira_action')));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ setup: 'applied', agents_created: 2 });

    // SC-002: the workspace is STILL paused after generation…
    const wsRes = await fetch(`${url}/api/workspaces/${ws.id}`, { headers: authHeaders });
    expect(((await wsRes.json()) as { enabled: boolean }).enabled).toBe(false);

    // FR-002: no re-generation once worker agents exist.
    const again = await generate(ws.id);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('worker_agents_exist');

    // The human gate: resolve the review task, then the single Start switch.
    const resolveRes = await fetch(`${url}/api/human-tasks/${tasks[0].id}/resolve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'done_manually', resolved_by: 'tester' }),
    });
    expect(resolveRes.status).toBe(200);

    const startRes = await fetch(`${url}/api/workspaces/${ws.id}/settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(startRes.status).toBe(200);
    const started = await fetch(`${url}/api/workspaces/${ws.id}`, { headers: authHeaders });
    expect(((await started.json()) as { enabled: boolean }).enabled).toBe(true);

    // Replay idempotency (SC-007): re-running completion processing no-ops.
    const pipeline = worker.get(PipelineService, { strict: false });
    await pipeline.onRunFinished(run_id);
    expect(await workerAgents(ws.id)).toHaveLength(2);
    const tasksAfter = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.workspaceId, ws.id), eq(schema.humanTasks.kind, 'review')));
    expect(tasksAfter).toHaveLength(1);
  });

  it('ticketless run renders in the runs list, card, and source filter (US4 backend)', async () => {
    // Reuses Scenario A's workspace — find its setup run through the API.
    const [ws] = await db.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.name, 'setup-ws-1'));

    const listRes = await fetch(
      `${url}/api/workspaces/${ws.id}/runs?source=workspace-setup`,
      { headers: authHeaders },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: { run_id: string; ticket: unknown }[]; total: number };
    expect(list.total).toBe(1);
    expect(list.items[0].ticket).toBeNull();

    const cardRes = await fetch(`${url}/api/runs/${list.items[0].run_id}`, { headers: authHeaders });
    expect(cardRes.status).toBe(200);
    const card = (await cardRes.json()) as { ticket: unknown; history: unknown[] };
    expect(card.ticket).toBeNull();
    expect(card.history.length).toBeGreaterThanOrEqual(1);
  });

  it('SC-003: concurrent generate requests yield exactly one active setup run', async () => {
    const ws = await createWorkspace();
    // `delay` holds the run in `running` long enough for assertions.
    await armOrchestrator(ws.id, { mock_scenario: 'delay' });

    const [a, b] = await Promise.all([generate(ws.id), generate(ws.id)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);

    const active = await setupRuns(ws.id);
    expect(active).toHaveLength(1);

    // After the run terminates, generation is available again (empty roster).
    await waitFor(async () => {
      const runs = await setupRuns(ws.id);
      return runs.every((r) => ['succeeded', 'failed'].includes(r.status));
    });
    const third = await generate(ws.id);
    expect(third.status).toBe(202);
    await waitFor(async () => (await setupRuns(ws.id)).every((r) => ['succeeded', 'failed'].includes(r.status)));
  });

  it('SC-004: an invalid proposal creates ZERO agents; the run fail-closes with a ticketless human task and no triage', async () => {
    const ws = await createWorkspace();
    await armOrchestrator(ws.id, { mock_scenario: 'team_invalid' });

    const res = await generate(ws.id);
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    await waitFor(async () => {
      const [r] = await db.db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, run_id));
      return r?.status === 'failed';
    });

    // Zero agents — the whole proposal was rejected atomically.
    expect(await workerAgents(ws.id)).toHaveLength(0);

    // The failure carries the validation issues and surfaces as a human task.
    const [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, run_id));
    expect(run.error).toContain('status_absent');

    const tasks = await db.db
      .select()
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.workspaceId, ws.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].ticketId).toBeNull();
    expect(tasks[0].blocking).toBe(false);
    expect(tasks[0].title).toContain('Workspace setup failed');

    // Never triaged: the failed setup run spawned no further runs.
    expect(await setupRuns(ws.id)).toHaveLength(1);
  });

  it('feature 014 (I1/D4): two proposed agents that slug to the SAME key are rejected cleanly — no 500, zero agents', async () => {
    // Names may now repeat, but two agents deriving the SAME key would collide on
    // insert, so the proposal is bounced back (distinct triggers keep this from
    // tripping duplicate_trigger first).
    const ws = await createWorkspace();
    const roster = team();
    roster[0] = { ...roster[0], name: 'Hera', role: 'Reviewer' };
    roster[1] = { ...roster[1], name: 'Hera', role: 'Reviewer' }; // both → key "hera-reviewer"
    await armOrchestrator(ws.id, { mock_scenario: 'team', team_proposal: roster });

    const res = await generate(ws.id);
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    await waitFor(async () => {
      const [r] = await db.db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, run_id));
      return r?.status === 'failed';
    });
    const [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, run_id));
    expect(run.error).toContain('duplicate_name');
    expect(await workerAgents(ws.id)).toHaveLength(0);
  });

  it('FR-020/D12: a parked setup run resumes as a NEW workspace-setup run carrying the Q&A; target_agent_id is rejected', async () => {
    const ws = await createWorkspace();
    const orchestratorId = await armOrchestrator(ws.id, { mock_scenario: 'needs_human' });

    const res = await generate(ws.id);
    const { run_id } = (await res.json()) as { run_id: string };

    await waitFor(async () => {
      const [r] = await db.db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, run_id));
      return r?.status === 'awaiting_human';
    });

    const [task] = await db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.workspaceId, ws.id), eq(schema.humanTasks.status, 'open')));
    expect(task.blocking).toBe(true);
    expect(task.ticketId).toBeNull();

    // A ticketless task cannot be routed to a worker (there is no ticket).
    const withTarget = await fetch(`${url}/api/human-tasks/${task.id}/resolve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'resume', answer: 'x', target_agent_id: orchestratorId }),
    });
    // invalid_target maps to 400 on this endpoint (same as feature 010's path).
    expect(withTarget.status).toBe(400);

    // Plain resume → a NEW workspace-setup run (never answer-triage).
    const resumed = await fetch(`${url}/api/human-tasks/${task.id}/resolve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'resume', answer: 'Focus on the backend tickets first.' }),
    });
    expect(resumed.status).toBe(200);

    const runs = await setupRuns(ws.id);
    expect(runs).toHaveLength(2);
    const parked = runs.find((r) => r.id === run_id)!;
    expect(parked.status).toBe('superseded');
    const fresh = runs.find((r) => r.id !== run_id)!;
    const trigger = fresh.triggerEvent as { source?: string; resolution?: string; human_task_id?: string };
    expect(trigger.source).toBe('workspace-setup');
    expect(trigger.resolution).toBe('Focus on the backend tickets first.');
    expect(trigger.human_task_id).toBe(task.id);

    // The resumed run's prompt carries the setup handoff WITH the Q&A block.
    await waitFor(async () =>
      runSpy.mock.calls.some((c) => (c[0] as { runId: string }).runId === fresh.id),
    );
    const call = runSpy.mock.calls.find((c) => (c[0] as { runId: string }).runId === fresh.id)!;
    const ctx = call[0] as { instruction: string };
    expect(ctx.instruction).toContain('## Workspace setup');
    expect(ctx.instruction).toContain('Focus on the backend tickets first.');
  });

  it('FR-014: a `team` report from a ticketed worker run is recast as a failure', async () => {
    const ws = await createWorkspace();

    const [agent] = await db.db
      .insert(schema.agents)
      .values({
        workspaceId: ws.id,
        executorId: mockProfileId,
        name: 'Rogue',
        key: 'rogue',
        instruction: 'You are not the orchestrator.',
        triggerStatus: 'Ready for Dev',
        statusSuccess: 'Done',
        statusFailure: 'Blocked',
        behavior: { mock_scenario: 'team' },
        enabled: true,
      })
      .returning({ id: schema.agents.id });
    const [ticket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: ws.id, jiraKey: 'BRIG-900', jiraId: '900', summary: 'rogue' })
      .returning({ id: schema.tickets.id });
    jira.seedIssue('BRIG-900', { status: 'Ready for Dev' });

    const trigger = worker.get(RunTriggerService, { strict: false });
    const result = await trigger.trigger({
      ticketId: ticket.id,
      agentId: agent.id,
      triggerEvent: { source: 'manual', mock_scenario: 'team' } as never,
    });
    expect(result.deduplicated).toBe(false);
    const runId = (result as { runId: string }).runId;

    await waitFor(async () => {
      const [r] = await db.db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, runId));
      return r?.status === 'failed';
    });
    const [run] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run.error).toContain('invalid team outcome');
    // No agents were created by the rogue proposal.
    const created = await db.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, ws.id), eq(schema.agents.name, 'Developer')));
    expect(created).toHaveLength(0);
  });
});

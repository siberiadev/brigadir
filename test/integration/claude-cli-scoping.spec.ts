import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { encodeJiraCredentials } from '@brigadir/jira';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const execFileAsync = promisify(execFile);
const BASE = 'https://mock.atlassian.net';

/**
 * Ticket-component repository scoping (feature 020): with a workspace's
 * `ticket_scoping` flag ON, the ticket's Jira Components intersect the agent's
 * base set (D1), non-repo names filter silently (D3), an undeterminable scope
 * parks fail-closed with a case-specific question (D2, guarded park), the gate
 * skips single-repo base sets (D2a), and the flag OFF is byte-identical to
 * pre-020 behavior (D2b). Dispatch reads components via getIssue against the
 * mock Jira; Postgres/Redis are real (global-setup).
 */
describe('claude_cli ticket-component repository scoping (feature 020)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let backendUrl: string;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let infraRemoteDir: string;
  let docsRemoteDir: string;
  let nextTicket = 700;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();

    // Two extra local remotes beside the harness "product" remote, so the
    // workspace can hold three repos (needed to tell D1 never-widens from the
    // D2a single-repo skip).
    for (const [name, assign] of [
      ['infra', (d: string) => (infraRemoteDir = d)],
      ['docs', (d: string) => (docsRemoteDir = d)],
    ] as const) {
      const dir = join(env.root, `${name}-remote`);
      await execFileAsync('git', ['init', '-b', 'main', dir]);
      await writeFile(join(dir, 'README.md'), `# ${name} repo\n`);
      await execFileAsync('git', ['add', '-A'], { cwd: dir });
      await execFileAsync(
        'git',
        ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'],
        { cwd: dir },
      );
      assign(dir);
    }

    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    // DB-only boot: workspace settings are the sole repository source.
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    // Backend hosts the human-task resolve endpoint for the park->resume round trip.
    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  const repositories = () => [
    { name: 'product', git_url: env.remoteDir, default_branch: 'main' },
    { name: 'infra', git_url: infraRemoteDir, default_branch: 'main' },
    { name: 'docs', git_url: docsRemoteDir, default_branch: 'main' },
  ];

  async function triggerRun(opts: {
    behavior?: Record<string, unknown>;
    /** Components seeded on the mock Jira issue. Omit key ⇒ ticket has none. */
    components?: string[];
    ticketScoping?: boolean;
    workspaceSettings?: Record<string, unknown>;
    fixture?: string;
  }): Promise<{ runId: string; ticketKey: string; ticketId: string; agentId: string; workspaceId: string }> {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = opts.fixture ?? 'stream-success';
    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress', components: opts.components ?? [] });
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env),
      behavior: { allowed_tools: ['Read'], ...(opts.behavior ?? {}) },
      workspaceSettings: opts.workspaceSettings ?? {
        repositories: repositories(),
        ...(opts.ticketScoping === false ? {} : { ticket_scoping: true }),
      },
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      maxAttempts: 1,
    });
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return { runId: res.runId, ticketKey, ticketId: p.ticketId, agentId: p.agentId, workspaceId: p.workspaceId };
  }

  async function pollRun(
    runId: string,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const TERMINAL = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && TERMINAL.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Was `repoName` actually mounted for this run? Feature 023 removed the
   * system-created `run/<ticket>` branch that used to be the discriminator
   * (caches persist across tests, so the cache dir alone proves nothing). The
   * per-repo `start-ref` timeline event is the durable per-RUN record of what
   * was mounted, written before the worktree that cleanup later removes.
   */
  async function mountedInRun(runId: string, repoName: string): Promise<boolean> {
    const rows = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .some((p) => p?.source === 'start-ref' && p?.repo === repoName);
  }

  /** The run's repo-scoping timeline events (feature 020, FR-015). */
  async function scopingEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === 'repo-scoping');
  }

  async function openTasks(runId: string) {
    return db.db
      .select()
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, runId), eq(schema.humanTasks.status, 'open')));
  }

  // ---------------------------------------------------------------- US1: narrowing

  it('components naming a subset ⇒ only that subset cloned and mounted (SC-001)', async () => {
    const { runId, ticketKey } = await triggerRun({ components: ['infra'] });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect(await mountedInRun(runId, 'product')).toBe(false);
    expect(await mountedInRun(runId, 'docs')).toBe(false);

    const events = await scopingEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      gate: 'passed',
      matched: ['infra'],
      ignored: [],
      effective: ['infra'],
    });
  });

  it('a non-repo component ("Design") is ignored when another matches — never fails the run (FR-004, D3)', async () => {
    const { runId, ticketKey } = await triggerRun({ components: ['Design', 'infra'] });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect(await mountedInRun(runId, 'product')).toBe(false);

    const events = await scopingEvents(runId);
    expect(events[0]).toMatchObject({ gate: 'passed', ignored: ['Design'], effective: ['infra'] });
  });

  it('components can never widen beyond the agent scope — workspace repo outside scope stays out (FR-003, D1)', async () => {
    // Agent scoped to product+infra; ticket also names docs (a real workspace repo).
    const { runId, ticketKey } = await triggerRun({
      behavior: { repositories: ['product', 'infra'] },
      components: ['infra', 'docs'],
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect(await mountedInRun(runId, 'docs')).toBe(false);
    expect(await mountedInRun(runId, 'product')).toBe(false);

    const events = await scopingEvents(runId);
    expect(events[0]).toMatchObject({ gate: 'passed', effective: ['infra'] });
  });

  it('an unscoped agent in a multi-repo workspace narrows the same way (base set = all repos)', async () => {
    const { runId, ticketKey } = await triggerRun({ components: ['docs'] });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'docs')).toBe(true);
    expect(await mountedInRun(runId, 'product')).toBe(false);
    expect(await mountedInRun(runId, 'infra')).toBe(false);
  });

  // ---------------------------------------------------------------- US2: fail-closed parking

  it('each D2 condition parks the run with its own distinct question text and zero clone work (FR-007/008)', async () => {
    const cases: Array<{
      name: string;
      opts: Parameters<typeof triggerRun>[0];
      titlePattern: RegExp;
      gate: string;
    }> = [
      {
        name: 'no components',
        opts: {},
        titlePattern: /^Set Components on BRIG-\d+ so the agent knows which repositories to work in$/,
        gate: 'parked:no_components',
      },
      {
        name: 'only non-repo components',
        opts: { components: ['Design', 'QA'] },
        titlePattern: /^None of BRIG-\d+'s components map to a repository — add the repository component$/,
        gate: 'parked:no_repo_components',
      },
      {
        name: 'disjoint from agent scope',
        opts: { behavior: { repositories: ['product', 'infra'] }, components: ['docs'] },
        titlePattern:
          /^BRIG-\d+ targets repositories this agent is not configured for — check routing or the agent's scope$/,
        gate: 'parked:outside_agent_scope',
      },
    ];

    const titles: string[] = [];
    for (const c of cases) {
      const { runId, ticketKey } = await triggerRun(c.opts);
      const row = await pollRun(runId);
      expect(row.status, c.name).toBe('awaiting_human');
      // Rule 7: the processor's crashed mapping never clobbered the park.
      expect(row.error, c.name).toBeNull();

      const tasks = await openTasks(runId);
      expect(tasks, c.name).toHaveLength(1);
      expect(tasks[0], c.name).toMatchObject({ kind: 'blocker', blocking: true });
      expect(tasks[0].title, c.name).toMatch(c.titlePattern);
      titles.push(tasks[0].title.replace(/BRIG-\d+/, 'BRIG-N'));

      // The park drove the Jira side: blocked transition + question comment.
      expect(mock.transitionsFor(ticketKey), c.name).toContain('Blocked');
      const comments = mock.commentsFor(ticketKey);
      expect(JSON.stringify(comments[comments.length - 1]), c.name).toContain(tasks[0].title);

      // FR-008: the gate fired BEFORE any clone — no branch in any cache.
      for (const repo of ['product', 'infra', 'docs']) {
        expect(await mountedInRun(runId, repo), `${c.name}: ${repo}`).toBe(false);
      }

      const events = await scopingEvents(runId);
      expect(events, c.name).toHaveLength(1);
      expect(events[0].gate, c.name).toBe(c.gate);
    }

    // SC-002: an operator can tell the three conditions apart by text alone.
    expect(new Set(titles).size).toBe(3);
  });

  it('unreadable components under an active gate fail the run closed — no park, no full-set clone (R5)', async () => {
    resetFakeClaudeEnv();
    process.env.FAKE_CLAUDE_FIXTURE = 'stream-success';
    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress', components: ['infra'] });
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env),
      behavior: { allowed_tools: ['Read'] },
      workspaceSettings: { repositories: repositories(), ticket_scoping: true },
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      maxAttempts: 1,
    });
    mock.arm500OnNextIssueGet(); // dispatch-time getIssue fails → components null
    const res = await trigger.trigger({ ticketId: p.ticketId, agentId: p.agentId, triggerEvent: { source: 'manual' } });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/components could not be read from Jira.*failing closed/);
    expect(await openTasks(res.runId)).toHaveLength(0);
    for (const repo of ['product', 'infra', 'docs']) {
      expect(await mountedInRun(res.runId, repo)).toBe(false);
    }
    const events = await scopingEvents(res.runId);
    expect(events[0]?.gate).toBe('failed:components_unreadable');
  });

  it('park → human sets Components → resolve ⇒ successor run re-reads the ticket and mounts the subset (FR-011, SC-004)', async () => {
    const { runId, ticketKey } = await triggerRun({}); // no components ⇒ parks (case 1)
    const parked = await pollRun(runId);
    expect(parked.status).toBe('awaiting_human');
    const tasks = await openTasks(runId);
    expect(tasks).toHaveLength(1);

    // The human fixes the ticket, then resolves the task through the real endpoint.
    mock.setComponents(ticketKey, ['infra']);
    const resolveRes = await fetch(`${backendUrl}/api/human-tasks/${tasks[0].id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` },
      body: JSON.stringify({ action: 'resume', answer: 'Components set to infra.', resolved_by: 'op@team' }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as { ok: boolean; newRunId: string };
    expect(resolveBody.ok).toBe(true);

    const [oldRun] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
    expect(oldRun.status).toBe('superseded');

    const successor = await pollRun(resolveBody.newRunId);
    expect(successor.status).toBe('succeeded');
    // The SUCCESSOR is the run that mounted anything — the parked one never did.
    expect(await mountedInRun(resolveBody.newRunId, 'infra')).toBe(true);
    expect(await mountedInRun(resolveBody.newRunId, 'product')).toBe(false);
    expect(await mountedInRun(resolveBody.newRunId, 'docs')).toBe(false);
    expect(await mountedInRun(runId, 'infra')).toBe(false);

    const events = await scopingEvents(resolveBody.newRunId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ gate: 'passed', effective: ['infra'] });
  });

  // ---------------------------------------------------------------- US3: flag OFF = byte-identical legacy behavior

  it('flag OFF (default): components have NO effect — full base set, no park, no scoping event (FR-005)', async () => {
    // Same ticket shape that NARROWS when the flag is on (see the first US1 test)
    // and PARKS on empty intersection — here it must behave exactly as pre-020.
    const { runId, ticketKey } = await triggerRun({ ticketScoping: false, components: ['infra'] });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    // ALL workspace repositories mounted, exactly as before feature 020.
    for (const repo of ['product', 'infra', 'docs']) {
      expect(await mountedInRun(runId, repo), repo).toBe(true);
    }
    expect(await scopingEvents(runId)).toHaveLength(0);
    expect(await openTasks(runId)).toHaveLength(0);
  });

  it('flag OFF: a ticket with no components proceeds exactly as today — nothing parks', async () => {
    const { runId, ticketKey } = await triggerRun({ ticketScoping: false });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'product')).toBe(true);
    expect(await scopingEvents(runId)).toHaveLength(0);
  });

  it('flag OFF: deprecated behavior.repository agents keep their one-repo path untouched', async () => {
    const { runId, ticketKey } = await triggerRun({
      ticketScoping: false,
      behavior: { repository: 'infra' },
      components: ['product'], // would contradict the scope if consulted — must be ignored
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect(await mountedInRun(runId, 'product')).toBe(false);
    expect(await scopingEvents(runId)).toHaveLength(0);
  });

  it('per-workspace isolation: the flag-ON workspace narrows while a flag-OFF one does not (Story 3, scenario 3)', async () => {
    // Two separate workspaces (each triggerRun seeds its own), identical tickets.
    const on = await triggerRun({ components: ['infra'] });
    const off = await triggerRun({ ticketScoping: false, components: ['infra'] });
    expect((await pollRun(on.runId)).status).toBe('succeeded');
    expect((await pollRun(off.runId)).status).toBe('succeeded');
    expect(await mountedInRun(on.runId, 'product')).toBe(false); // narrowed
    expect(await mountedInRun(off.runId, 'product')).toBe(true); // untouched legacy
  });

  // ---------------------------------------------------------------- US4: the gate never over-blocks

  it('flag ON + single-repo base set: no components, no park — the gate skips (FR-006, D2a)', async () => {
    // Agent scoped to ONE repo; the ticket carries no components at all.
    const { runId, ticketKey } = await triggerRun({ behavior: { repositories: ['infra'] } });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await openTasks(runId)).toHaveLength(0);
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    const events = await scopingEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].gate).toBe('skipped_single_repo');
  });

  it('flag ON + deprecated behavior.repository: one-element base set skips the gate the same way (D2a)', async () => {
    const { runId, ticketKey } = await triggerRun({
      behavior: { repository: 'infra' },
      components: ['Design'], // matches nothing — must still not park (single-repo skip wins)
    });
    const row = await pollRun(runId);
    expect(row.status).toBe('succeeded');
    expect(await openTasks(runId)).toHaveLength(0);
    expect(await mountedInRun(runId, 'infra')).toBe(true);
    expect((await scopingEvents(runId))[0].gate).toBe('skipped_single_repo');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  setFakeClaudeCallbacks,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const execFileAsync = promisify(execFile);
const BASE = 'https://mock.atlassian.net';
const JWT_SECRET = 'blocker-inheritance-test-jwt-secret';

/**
 * Feature 032 — a dependent run starts from its BLOCKER's unmerged work.
 *
 * Feature 023 taught a run to continue the branch the previous stage of the
 * SAME ticket reported. That leaves chained tickets stranded: `B is blocked by
 * A` starts B from the default branch, where A's unmerged work does not exist,
 * so B's agent builds against code that is not there. Here B starts from A's
 * branch — and every way that can fail (branch gone, two blockers conflicting,
 * work in a repository B does not mount) is loud and diagnosable instead of a
 * silent default-branch start.
 */
describe('blocker branch inheritance (feature 032)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;
  let backendRemoteDir: string;
  let frontendRemoteDir: string;
  let nextTicket = 300;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();

    // Two extra remotes so the cross-service case (US4) is a real two-repo run.
    for (const [name, assign] of [
      ['backend', (d: string) => (backendRemoteDir = d)],
      ['frontend', (d: string) => (frontendRemoteDir = d)],
    ] as const) {
      const dir = join(env.root, `${name}-remote`);
      await execFileAsync('git', ['init', '-b', 'main', dir]);
      await writeFile(join(dir, 'README.md'), `# ${name}\n`);
      await execFileAsync('git', ['add', '-A'], { cwd: dir });
      await execFileAsync(
        'git',
        ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'init'],
        { cwd: dir },
      );
      assign(dir);
    }

    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    mock.setCategory('In Review', 'indeterminate');
    mock.setCategory('Done', 'done');

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    process.env.BRIGADIR_CALLBACK_BASE_URL = `${await backend.getUrl()}/api/callbacks`;

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

  // --- fixtures ---------------------------------------------------------

  /** Push a branch carrying one commit onto a local "remote", return its SHA. */
  async function pushWork(remoteDir: string, branch: string, file: string, content = 'work\n') {
    const git = (...args: string[]) => execFileAsync('git', ['-C', remoteDir, ...args]);
    await git('switch', '-c', branch);
    await writeFile(join(remoteDir, file), content);
    await git('add', '-A');
    await git('-c', 'user.email=d@e.io', '-c', 'user.name=D', 'commit', '-m', `work on ${branch}`);
    const { stdout } = await git('rev-parse', 'HEAD');
    await git('switch', 'main');
    return stdout.trim();
  }

  async function deleteRemoteBranch(remoteDir: string, branch: string): Promise<void> {
    await execFileAsync('git', ['-C', remoteDir, 'branch', '-D', branch]);
  }

  const productRepo = () => [{ name: 'product', git_url: env.remoteDir, default_branch: 'main' }];
  const serviceRepos = () => [
    { name: 'backend', git_url: backendRemoteDir, default_branch: 'main' },
    { name: 'frontend', git_url: frontendRemoteDir, default_branch: 'main' },
  ];

  interface BlockerSpec {
    /** Jira status the blocker sits in (drives the done/not-done asymmetry). */
    status: string;
    /** `artifacts.repos` of its succeeded run; omit ⇒ it reported nothing. */
    repos?: { repo: string; branch: string; pr_url?: string }[];
  }

  /**
   * A dependent ticket plus its blockers: blocker ticket rows + succeeded runs
   * carrying reports, and the dependent's `blocked_by` observation — exactly
   * the state the poller leaves behind (data-model.md §2).
   */
  async function seedChain(opts: {
    blockers: BlockerSpec[];
    repositories?: { name: string; git_url: string; default_branch: string }[];
    agentRepositories?: string[];
  }) {
    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress' });
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, {
        useCallbackChannel: true,
        keepFailedWorktrees: true,
      }),
      behavior: {
        allowed_tools: ['Read', 'Edit', 'Bash(git *)'],
        ...(opts.agentRepositories ? { repositories: opts.agentRepositories } : {}),
      },
      workspaceSettings: { repositories: opts.repositories ?? productRepo() },
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      maxAttempts: 1,
    });

    const blockerKeys: string[] = [];
    for (const spec of opts.blockers) {
      const key = `BRIG-${nextTicket++}`;
      blockerKeys.push(key);
      mock.seedIssue(key, { status: spec.status });
      const [blockerTicket] = await db.db
        .insert(schema.tickets)
        .values({
          workspaceId: p.workspaceId,
          jiraKey: key,
          jiraId: '20000',
          summary: key,
          lastSeenStatus: spec.status,
        })
        .returning({ id: schema.tickets.id });
      await db.db.insert(schema.runs).values({
        workspaceId: p.workspaceId,
        ticketId: blockerTicket.id,
        agentId: p.agentId,
        executorType: 'claude_cli',
        status: 'succeeded',
        outcome: 'success',
        attempt: 1,
        report: {
          schema_version: 2,
          outcome: 'success',
          summary: `${key} implemented.`,
          checks: [],
          ...(spec.repos ? { artifacts: { repos: spec.repos } } : {}),
        },
      });
    }

    // What the poller writes on every observation (feature 032).
    await db.db
      .update(schema.tickets)
      .set({ blockedBy: blockerKeys })
      .where(eq(schema.tickets.id, p.ticketId));

    return { ...p, ticketKey, blockerKeys };
  }

  async function runDependent(p: { ticketId: string; agentId: string }): Promise<string> {
    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'Built on the blocker.', checks: [] },
      },
    ]);
    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'poll' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');
    return res.runId;
  }

  async function pollRun(runId: string, timeoutMs = 40_000) {
    const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && terminal.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} stuck at ${row?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function startRefEvents(runId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p?.source === 'start-ref');
  }

  async function openTasks(ticketId: string): Promise<{ title: string; details: string | null }[]> {
    return db.db
      .select({ title: schema.humanTasks.title, details: schema.humanTasks.details })
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.ticketId, ticketId), eq(schema.humanTasks.status, 'open')));
  }

  const headOf = async (dir: string) =>
    (await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();

  // --- US2: single-blocker inheritance ---------------------------------

  it('starts the dependent at the blocker\'s reported branch, and says so', async () => {
    const branch = 'run/blocker-a';
    const sha = await pushWork(env.remoteDir, branch, 'blocker-a.txt');
    const p = await seedChain({
      blockers: [{ status: 'In Review', repos: [{ repo: 'product', branch, pr_url: 'https://x/1' }] }],
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');

    // The worktree really is at the blocker's tip — the work is present.
    const worktree = join(row.worktreePath!, 'product');
    expect(await headOf(worktree)).toBe(sha);
    expect(existsSync(join(worktree, 'blocker-a.txt'))).toBe(true);

    const events = await startRefEvents(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repo: 'product',
      decision: 'inherited_from_blocker',
      continueBranch: branch,
      startSha: sha,
    });
    expect(events[0].blockers).toMatchObject([{ key: p.blockerKeys[0], branch }]);

    // The agent is told this is a DEPENDENCY, and what it is chained to.
    const wrapper = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapper).toContain(`DEPENDENCY — branch ${branch} from ${p.blockerKeys[0]}`);
    expect(wrapper).toContain('## Linked tickets');
    expect(wrapper).toContain(`- ${p.blockerKeys[0]} [In Review] branch: ${branch} PR: https://x/1`);

    // No diagnostics: nothing went wrong.
    expect(await openTasks(p.ticketId)).toEqual([]);
  });

  it('own prior work still wins over a blocker for the same repository', async () => {
    const blockerBranch = 'run/blocker-loses';
    await pushWork(env.remoteDir, blockerBranch, 'blocker.txt');
    const ownBranch = 'run/own-wins';
    const ownSha = await pushWork(env.remoteDir, ownBranch, 'own.txt');

    const p = await seedChain({
      blockers: [{ status: 'In Review', repos: [{ repo: 'product', branch: blockerBranch }] }],
    });
    // A prior stage of the DEPENDENT itself reported its own branch.
    await db.db.insert(schema.runs).values({
      workspaceId: p.workspaceId,
      ticketId: p.ticketId,
      agentId: p.agentId,
      executorType: 'claude_cli',
      status: 'succeeded',
      outcome: 'success',
      attempt: 1,
      report: {
        schema_version: 2,
        outcome: 'success',
        summary: 'Stage 1 of the dependent.',
        checks: [],
        artifacts: { repos: [{ repo: 'product', branch: ownBranch }] },
      },
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');
    expect(await headOf(join(row.worktreePath!, 'product'))).toBe(ownSha);
    expect((await startRefEvents(row.id))[0]).toMatchObject({ decision: 'report_confirmed' });
  });

  // --- US2: the missing-branch asymmetry -------------------------------

  it('a DONE blocker whose branch is gone starts from the default branch quietly', async () => {
    const branch = 'run/merged-and-deleted';
    await pushWork(env.remoteDir, branch, 'merged.txt');
    const p = await seedChain({
      blockers: [{ status: 'Done', repos: [{ repo: 'product', branch }] }],
    });
    await deleteRemoteBranch(env.remoteDir, branch);

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');
    // Started from main; the blocker's work is already merged there in reality.
    expect(existsSync(join(row.worktreePath!, 'product', 'merged.txt'))).toBe(false);

    const decisions = (await startRefEvents(row.id)).map((e) => e.decision);
    expect(decisions).toContain('blocker_branch_merged');
    // Quiet: the normal end of a chain is not a human problem.
    expect(await openTasks(p.ticketId)).toEqual([]);
  });

  it('an OPEN blocker with no usable branch proceeds but raises exactly one task', async () => {
    const branch = 'run/open-but-lost';
    await pushWork(env.remoteDir, branch, 'lost.txt');
    const p = await seedChain({
      blockers: [{ status: 'In Review', repos: [{ repo: 'product', branch }] }],
    });
    await deleteRemoteBranch(env.remoteDir, branch);

    const first = await pollRun(await runDependent(p));
    expect(first.status).toBe('succeeded');
    expect(existsSync(join(first.worktreePath!, 'product', 'lost.txt'))).toBe(false);

    expect((await startRefEvents(first.id)).map((e) => e.decision)).toContain('blocker_no_artifact');
    const tasks = await openTasks(p.ticketId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe(
      `[blocker_branch_lost] ${p.ticketKey}: no usable branch from ${p.blockerKeys[0]} for product`,
    );
    expect(tasks[0].details).toContain('In Review');

    // A second run in the same condition records the event again but must NOT
    // pile a second identical task onto the queue.
    const second = await pollRun(await runDependent(p));
    expect((await startRefEvents(second.id)).map((e) => e.decision)).toContain('blocker_no_artifact');
    expect(await openTasks(p.ticketId)).toHaveLength(1);
  });

  it('an OPEN blocker that reported nothing at all is the same case', async () => {
    const p = await seedChain({ blockers: [{ status: 'In Review' }] });
    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');
    expect((await startRefEvents(row.id)).map((e) => e.decision)).toContain('blocker_no_artifact');
    expect(await openTasks(p.ticketId)).toHaveLength(1);
  });

  // --- US3: diamonds ---------------------------------------------------

  it('merges two blockers\' branches into the start point (clean case)', async () => {
    const a = 'run/diamond-a';
    const b = 'run/diamond-b';
    await pushWork(env.remoteDir, a, 'diamond-a.txt');
    await pushWork(env.remoteDir, b, 'diamond-b.txt');
    const p = await seedChain({
      blockers: [
        { status: 'In Review', repos: [{ repo: 'product', branch: a }] },
        { status: 'In Review', repos: [{ repo: 'product', branch: b }] },
      ],
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');

    // BOTH blockers' work is in the start point.
    const worktree = join(row.worktreePath!, 'product');
    expect(existsSync(join(worktree, 'diamond-a.txt'))).toBe(true);
    expect(existsSync(join(worktree, 'diamond-b.txt'))).toBe(true);

    const [event] = await startRefEvents(row.id);
    expect(event).toMatchObject({ decision: 'merged_blockers', continueBranch: a });
    expect(event.mergedBranches).toEqual([b]);
    expect((event.blockers as { key: string }[]).map((x) => x.key)).toEqual(p.blockerKeys);

    const wrapper = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapper).toContain(`continues ${a} from ${p.blockerKeys[0]} merged with ${b} from ${p.blockerKeys[1]}`);
    expect(wrapper).toContain(`open your PR against ${a}, not main`);
  });

  /**
   * Feature 024's completion gate compares the worktree HEAD against
   * `startSha`. `startSha` is resolved AFTER the merge, so a merged start point
   * is the baseline by construction and a normal completion still passes.
   */
  it('a run started at a merge commit passes the completion gate unchanged', async () => {
    const a = 'run/gate-a';
    const b = 'run/gate-b';
    await pushWork(env.remoteDir, a, 'gate-a.txt');
    await pushWork(env.remoteDir, b, 'gate-b.txt');
    const p = await seedChain({
      blockers: [
        { status: 'In Review', repos: [{ repo: 'product', branch: a }] },
        { status: 'In Review', repos: [{ repo: 'product', branch: b }] },
      ],
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');
    expect(row.outcome).toBe('success');
    // The gate's baseline is the merge commit, not either input branch's tip.
    const [event] = await startRefEvents(row.id);
    expect(await headOf(join(row.worktreePath!, 'product'))).toBe(event.startSha);
  });

  it('conflicting blocker branches fail the run loudly with one actionable task', async () => {
    const a = 'run/conflict-a';
    const b = 'run/conflict-b';
    await pushWork(env.remoteDir, a, 'shared.txt', 'from A\n');
    await pushWork(env.remoteDir, b, 'shared.txt', 'from B\n');
    const p = await seedChain({
      blockers: [
        { status: 'In Review', repos: [{ repo: 'product', branch: a }] },
        { status: 'In Review', repos: [{ repo: 'product', branch: b }] },
      ],
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/blocker branches conflict/);

    const tasks = await openTasks(p.ticketId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe(
      `[blocker_merge_conflict] ${p.ticketKey}: blocker branches conflict in product`,
    );
    expect(tasks[0].details).toContain(a);
    expect(tasks[0].details).toContain(b);
  });

  // --- US4: cross-service ----------------------------------------------

  it('a cross-service dependent mounts the blocker\'s service at its branch, the rest at default', async () => {
    const branch = 'run/api-change';
    const sha = await pushWork(backendRemoteDir, branch, 'api.txt');
    const p = await seedChain({
      blockers: [{ status: 'In Review', repos: [{ repo: 'backend', branch }] }],
      repositories: serviceRepos(),
      agentRepositories: ['backend', 'frontend'],
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');

    expect(await headOf(join(row.worktreePath!, 'backend'))).toBe(sha);
    expect(existsSync(join(row.worktreePath!, 'backend', 'api.txt'))).toBe(true);
    // The untouched service stays on its own default branch.
    expect(existsSync(join(row.worktreePath!, 'frontend', 'api.txt'))).toBe(false);

    const byRepo = new Map((await startRefEvents(row.id)).map((e) => [e.repo, e]));
    expect(byRepo.get('backend')).toMatchObject({ decision: 'inherited_from_blocker' });
    expect(byRepo.get('frontend')).toMatchObject({ decision: 'default_branch' });

    const wrapper = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapper).toContain(`- backend: ${join(row.worktreePath!, 'backend')} (DEPENDENCY`);
    expect(wrapper).toContain(`- frontend: ${join(row.worktreePath!, 'frontend')} (no prior branch`);
  });

  it('blocker work in an unmounted repository is diagnosed, once, and the run proceeds', async () => {
    const branch = 'run/unmounted-work';
    await pushWork(backendRemoteDir, branch, 'unmounted.txt');
    const p = await seedChain({
      blockers: [{ status: 'In Review', repos: [{ repo: 'backend', branch }] }],
      repositories: serviceRepos(),
      // The dependent's agent mounts ONLY frontend — inheritance must not widen it.
      agentRepositories: ['frontend'],
    });

    const first = await pollRun(await runDependent(p));
    expect(first.status).toBe('succeeded');
    expect(existsSync(join(first.worktreePath!, 'backend'))).toBe(false);

    const unmounted = (await startRefEvents(first.id)).filter(
      (e) => e.decision === 'blocker_artifacts_unmounted',
    );
    expect(unmounted).toHaveLength(1);
    expect(unmounted[0]).toMatchObject({ repo: 'backend' });

    const tasks = await openTasks(p.ticketId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe(
      `[blocker_repo_unmounted] ${p.ticketKey}: blocker ${p.blockerKeys[0]} has work in unmounted backend`,
    );
    expect(tasks[0].details).toContain('Component');
    expect(tasks[0].details).toContain('repository scope');

    // Deduped across runs.
    await pollRun(await runDependent(p));
    expect(await openTasks(p.ticketId)).toHaveLength(1);
  });

  // --- US5: observability + FR-016 --------------------------------------

  it('every mounted repository gets exactly one start-ref event, boring cases included', async () => {
    const branch = 'run/one-event';
    await pushWork(backendRemoteDir, branch, 'one.txt');
    const p = await seedChain({
      blockers: [{ status: 'In Review', repos: [{ repo: 'backend', branch }] }],
      repositories: serviceRepos(),
      agentRepositories: ['backend', 'frontend'],
    });

    const row = await pollRun(await runDependent(p));
    const perRepo = (await startRefEvents(row.id)).filter(
      (e) => e.decision !== 'blocker_artifacts_unmounted',
    );
    expect(perRepo.map((e) => e.repo).sort()).toEqual(['backend', 'frontend']);
    expect(perRepo.every((e) => typeof e.startSha === 'string')).toBe(true);
  });

  it('a ticket with no observed blockers behaves exactly as before (FR-016)', async () => {
    const ticketKey = `BRIG-${nextTicket++}`;
    mock.seedIssue(ticketKey, { status: 'In Progress' });
    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true }),
      behavior: { allowed_tools: ['Read'] },
      workspaceSettings: { repositories: productRepo() },
      ticketKey,
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      maxAttempts: 1,
    });

    const row = await pollRun(await runDependent(p));
    expect(row.status).toBe('succeeded');
    const events = await startRefEvents(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'default_branch', continueBranch: null });
    expect(events[0].blockers).toBeUndefined();
    expect(events[0].mergedBranches).toBeUndefined();
    expect(await openTasks(p.ticketId)).toEqual([]);
  });
});

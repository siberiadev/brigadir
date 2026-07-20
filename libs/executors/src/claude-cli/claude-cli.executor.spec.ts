import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentsConfig } from '@brigadir/contracts';
import type { RunContext } from '../agent-executor.interface';

vi.mock('./worktree', async (importOriginal) => ({
  // Only the git-touching functions are faked; the rest are real.
  ...(await importOriginal<typeof import('./worktree')>()),
  prepareAll: vi.fn(),
  cleanupAll: vi.fn(),
}));
vi.mock('./process-group', () => ({
  spawnGroup: vi.fn(),
}));

import { prepareAll, cleanupAll } from './worktree';
import { spawnGroup } from './process-group';
import { ClaudeCliExecutor } from './claude-cli.executor';
import { DEFAULT_REPO_RUN_ALLOWED_TOOLS } from './claude-cli.config';

const prepareMock = prepareAll as unknown as ReturnType<typeof vi.fn>;
const cleanupMock = cleanupAll as unknown as ReturnType<typeof vi.fn>;
const spawnGroupMock = spawnGroup as unknown as ReturnType<typeof vi.fn>;

/** Fake MultiPrepareResult for a single-repo workspace rooted at `parentDir`. */
function fakeWorkspace(parentDir: string, repoName = 'product', continueBranch?: string) {
  return {
    parentDir,
    repos: [
      {
        repo: { name: repoName, url: `git@acme:${repoName}.git`, defaultBranch: 'main' },
        worktreeDir: join(parentDir, repoName),
        cacheDir: join(parentDir, '..', 'cache', repoName),
        // Feature 023: per-repo start ref; no run-level branch any more.
        // Feature 024: startSha is the gate baseline (fixed fake SHA).
        start: continueBranch
          ? { startRef: `origin/${continueBranch}`, continueBranch, startSha: 'a'.repeat(40) }
          : { startRef: 'origin/main', startSha: 'a'.repeat(40) },
      },
    ],
  };
}

const FIXTURES_DIR = join(process.cwd(), 'test', 'fixtures', 'claude-cli');
function readFixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES_DIR, `${name}.ndjson`), 'utf8').trim().split('\n');
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
}

function makeGroup() {
  const child = new FakeChild();
  // Models real async process death: terminate() resolves once the (fake)
  // process has actually exited, and the 'close' event fires as an
  // independent async event around the same time — never synchronously
  // inside terminate() itself (see the race this must NOT reproduce).
  const terminate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        setImmediate(() => {
          child.emit('close', null, 'SIGTERM');
          resolve();
        });
      }),
  );
  return { child, killGroup: vi.fn(), terminate };
}

// A group whose terminate() does NOT emit 'close' — models the incident where a
// setsid-escaped grandchild keeps the pipe fds open so the leader never closes
// until something else (the watchdog abort, a later manual kill) lands.
function makeGroupNoClose() {
  const child = new FakeChild();
  const terminate = vi.fn(() => Promise.resolve());
  return { child, killGroup: vi.fn(), terminate };
}

function fakeDb(executorConfig: unknown, behavior: unknown, settings: Record<string, unknown> = {}) {
  // run_events payloads captured for assertions (feature 020 repo-scoping event).
  const insertedEvents: unknown[] = [];
  return {
    insertedEvents,
    select: () => ({
      // Two select shapes: the run-config load (innerJoin chain) and the
      // feature-005 workspace-settings read (plain where().limit() — empty
      // settings by default so these tests keep resolving repos via the yaml
      // path; feature-020 scoping tests pass their own settings blob).
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  { executorConfig, behavior, workspaceId: 'ws-1', ticketId: 'tkt-1' },
                ]),
            }),
          }),
        }),
        where: () => ({
          limit: () => Promise.resolve([{ settings }]),
          // Feature 023 prior-work scan: runs on the ticket, newest first. No
          // prior run here, so every repo starts from its default branch.
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        insertedEvents.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
}

const agentsConfig = {
  workspace: {
    jira_site: 'https://acme.atlassian.net',
    project_key: 'BRIG',
    board_id: 1,
    default_branch: 'main',
    repositories: [{ name: 'product', url: 'git@acme:product.git', default_branch: 'main' }],
  },
  executors: {},
  agents: [],
} as unknown as AgentsConfig;

const executorConfig = {
  cliPath: 'claude',
  model: 'claude-sonnet-5',
  repository: 'product',
  allowedTools: ['Read'],
  keepFailedWorktrees: false,
  killGraceMs: 1000,
  cancelPollMs: 50,
};

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-1',
    ticket: { key: 'BRIG-1', summary: 'Test ticket', description: '', url: '', components: null },
    instruction: 'Implement the ticket.',
    workspaceDir: null,
    callback: { httpBaseUrl: 'http://x', runToken: 't' },
    limits: { timeoutMs: 60_000 },
    env: {},
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `run()` does real (fast, but async-via-libuv) fs I/O — mkdir/writeFile for
 * the wrapper file — before it ever calls `spawnGroup`. A single microtask
 * flush isn't guaranteed to outlast that, and emitting on `group.child`
 * before the executor has attached its listeners would be silently missed
 * (EventEmitter doesn't queue events for future listeners) — so wait for
 * `spawnGroup` to have actually been invoked before driving the fake child.
 */
async function waitForSpawn(mock: ReturnType<typeof vi.fn>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (mock.mock.calls.length === 0) {
    if (Date.now() > deadline) throw new Error('spawnGroup was never called');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ClaudeCliExecutor.run (T082)', () => {
  let worktreeDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(join(tmpdir(), 'brigadir-executor-test-'));
    prepareMock.mockReset().mockResolvedValue(fakeWorkspace(worktreeDir));
    cleanupMock.mockReset().mockResolvedValue(undefined);
    spawnGroupMock.mockReset();
  });

  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  function makeExecutor(config: unknown = executorConfig, behavior: Record<string, unknown> = {}) {
    const db = fakeDb(config, behavior);
    const fakeJira = { getFeatureContext: vi.fn().mockResolvedValue({ linked: [] }) };
    return new ClaudeCliExecutor(db as never, agentsConfig, fakeJira as never);
  }

  it('success: completed with a schema-valid report', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);

    const result = await runPromise;
    expect(result.exitStatus).toBe('completed');
    expect((result.report as { outcome: string }).outcome).toBe('success');
    expect(result.externalRef).toBe('sess-success-1');
    expect(result.costUsd).toBe(0.0123);
    // Feature 019: cleanup gets the whole workspace (parent dir + repo worktrees).
    expect(cleanupMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentDir: worktreeDir }),
      { keep: false },
    );
    // The child process runs from the PARENT dir (spec FR-005).
    expect(spawnGroupMock.mock.calls[0][2]).toMatchObject({ cwd: worktreeDir });
  });

  // Feature 024 (US2): branch_prefix is an inert stored field — present in
  // behavior, it is accepted (no throw) and produces NO wrapper suggestion.
  it('branch_prefix in behavior is accepted and ignored — no suggested branch in the wrapper', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor(executorConfig, { branch_prefix: 'feat' });

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    const wrapperText = await readFile(join(worktreeDir, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapperText).toContain('- product:');
    expect(wrapperText).toContain('(no prior branch; at main)');
    expect(wrapperText).not.toContain('create feat');
    expect(wrapperText).not.toMatch(/— create /);

    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);
    const result = await runPromise;
    expect(result.exitStatus).toBe('completed');
  });

  // Feature 024 (US3): start-ref events are written AFTER prepare and carry
  // the resolved startSha (the completion gate's baseline).
  it('records a start-ref run_event per repo with the resolved startSha', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const db = fakeDb(executorConfig, {});
    const fakeJira = { getFeatureContext: vi.fn().mockResolvedValue({ linked: [] }) };
    const executor = new ClaudeCliExecutor(db as never, agentsConfig, fakeJira as never);

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);
    await runPromise;

    const startRef = (db.insertedEvents as unknown[])
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .find((e) => (e as { payload?: { source?: string } })?.payload?.source === 'start-ref') as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(startRef).toBeDefined();
    expect(startRef!.payload).toMatchObject({
      repo: 'product',
      startSha: 'a'.repeat(40),
      decision: 'default_branch',
    });
  });

  it('invalid report: completed with no report and a diagnostic', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-invalid-report')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);

    const result = await runPromise;
    expect(result.exitStatus).toBe('completed');
    expect(result.report).toBeUndefined();
    expect(result.diagnostics).toMatch(/schema-valid structured_output/);
  });

  it('no report: completed with no report and a diagnostic', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-no-report')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);

    const result = await runPromise;
    expect(result.exitStatus).toBe('completed');
    expect(result.report).toBeUndefined();
    expect(result.diagnostics).toBeDefined();
  });

  it('crashed: nonzero exit with no result event ever seen', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    group.child.stderr.write('fatal: something went wrong\n');
    await flush();
    group.child.emit('close', 1, null);

    const result = await runPromise;
    expect(result.exitStatus).toBe('crashed');
    expect(result.diagnostics).toContain('fatal: something went wrong');
  });

  it('budget exceeded: terminal cost over the ceiling → crashed with a budget diagnostic', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();

    const runPromise = executor.run(makeCtx({ limits: { timeoutMs: 60_000, maxBudgetUsd: 0.05 } }), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-budget-exceeded')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);

    const result = await runPromise;
    expect(result.exitStatus).toBe('crashed');
    expect(result.diagnostics).toMatch(/budget exceeded/);
    expect(result.costUsd).toBe(0.12);
  });

  it('timeout: abort with reason "timeout" resolves exitStatus timeout and terminates the group', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await flush();
    controller.abort('timeout');

    const result = await runPromise;
    expect(result.exitStatus).toBe('timeout');
    expect(group.terminate).toHaveBeenCalledWith(1000);
  });

  it('cancelled: abort with reason "cancelled" resolves exitStatus cancelled', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await flush();
    controller.abort('cancelled');

    const result = await runPromise;
    expect(result.exitStatus).toBe('cancelled');
  });

  it('cancelled AFTER the terminal event was parsed still carries cost/usage on the result', async () => {
    // The processor's cancel-poll kills the lingering process after a
    // callback finalize/park — if the result event already streamed, its
    // cost/usage are the run's only cost data and must ride the abort settle.
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    await flush();
    controller.abort('cancelled');

    const result = await runPromise;
    expect(result.exitStatus).toBe('cancelled');
    expect(result.costUsd).toBe(0.0123);
    expect(result.usage).toMatchObject({ input_tokens: 1200, output_tokens: 340 });
    expect(result.externalRef).toBe('sess-success-1');
  });

  it('a late stream-success arriving after cancellation does not revive/override the result', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await flush();
    controller.abort('cancelled');
    const result = await runPromise;
    expect(result.exitStatus).toBe('cancelled');

    // A stray late write/close after settle must not change anything further —
    // the promise is already resolved and settle() is guarded.
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    group.child.emit('close', 0, null);
    await flush();

    expect(result.exitStatus).toBe('cancelled');
  });

  it('rate_limited: an api_retry(rate_limit) event terminates the group and resolves rate_limited', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();

    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await flush();
    for (const line of readFixtureLines('stream-rate-limit')) group.child.stdout.write(line + '\n');
    await flush();

    const result = await runPromise;
    expect(result.exitStatus).toBe('rate_limited');
    expect(group.terminate).toHaveBeenCalled();
  });

  it('rate_limit that outlives terminate() then hits a watchdog timeout still resolves rate_limited (incident 2026-07-19)', async () => {
    // Captain Nemo: opus rate-limited, executor called terminate(), but the
    // process lingered until the watchdog aborted with 'timeout' ~50min later.
    // A rate_limit already parsed must outrank that late timeout, else the run
    // finalizes timed_out and the subscription limit burns the attempt.
    const group = makeGroupNoClose();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-rate-limit')) group.child.stdout.write(line + '\n');
    await flush();
    // terminate() did not bring the process down; the watchdog fires much later.
    controller.abort('timeout');
    await flush();
    // Only now does the wedged process finally close.
    group.child.emit('close', null, 'SIGKILL');

    const result = await runPromise;
    expect(result.exitStatus).toBe('rate_limited');
  });

  it('a cancel after a rate_limit wins over the parked rate_limit (cancelled outranks)', async () => {
    const group = makeGroupNoClose();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-rate-limit')) group.child.stdout.write(line + '\n');
    await flush();
    controller.abort('cancelled');
    await flush();
    group.child.emit('close', null, 'SIGKILL');

    const result = await runPromise;
    expect(result.exitStatus).toBe('cancelled');
  });

  it('resolves exactly once even if budget-ish terminal and abort race (single-resolve guarantee)', async () => {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const executor = makeExecutor();
    const controller = new AbortController();

    const runPromise = executor.run(makeCtx(), controller.signal);
    await flush();
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    // Abort fires nearly simultaneously with the process's own natural close.
    controller.abort('timeout');
    group.child.emit('close', 0, null);

    const result = await runPromise;
    expect(['timeout', 'completed']).toContain(result.exitStatus);
  });

  it('prepare() failure returns crashed without spawning a process', async () => {
    prepareMock.mockReset().mockRejectedValue(new Error('branch already exists'));
    const executor = makeExecutor();

    const result = await executor.run(makeCtx(), new AbortController().signal);
    expect(result.exitStatus).toBe('crashed');
    expect(result.diagnostics).toContain('branch already exists');
    expect(spawnGroupMock).not.toHaveBeenCalled();
  });
});

/**
 * Feature 015 (T019): workspace-setup runs resolve a "fat" environment from
 * the live brigadir template's setup profile — capable model, larger turn
 * budget, repo-mounted with a ticketless `setup/<runId8>` branch — while every
 * other source keeps the agent's own profile byte-identically. Fallback on a
 * disabled setup executor records a run-timeline warning.
 */
describe('ClaudeCliExecutor — default allowed tools (ST3-768)', () => {
  let worktreeDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(join(tmpdir(), 'brigadir-tools-test-'));
    prepareMock.mockReset().mockResolvedValue(fakeWorkspace(worktreeDir));
    cleanupMock.mockReset().mockResolvedValue(undefined);
    spawnGroupMock.mockReset();
  });

  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  /** Drive one full fake run and return the --allowed-tools argv value. */
  async function driveForAllowedTools(
    config: Record<string, unknown>,
    behavior: Record<string, unknown>,
  ): Promise<string> {
    const db = fakeDb(config, behavior);
    const fakeJira = { getFeatureContext: vi.fn().mockResolvedValue({ linked: [] }) };
    const executor = new ClaudeCliExecutor(db as never, agentsConfig, fakeJira as never);

    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const runPromise = executor.run(makeCtx(), new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);
    await runPromise;

    const argv = spawnGroupMock.mock.calls[0][1] as string[];
    const idx = argv.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThan(-1);
    return argv[idx + 1];
  }

  const noToolsConfig = {
    cliPath: 'claude',
    model: 'claude-sonnet-5',
    keepFailedWorktrees: false,
    killGraceMs: 1000,
    cancelPollMs: 50,
  };

  it('a repo-mounted run with no configured tools gets the platform default toolset', async () => {
    const tools = await driveForAllowedTools(noToolsConfig, {});
    expect(tools).toBe(DEFAULT_REPO_RUN_ALLOWED_TOOLS.join(','));
    // The write/git capability the incident was about must actually be there.
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash');
  });

  it('an explicit agent behavior.allowed_tools wins over the platform default', async () => {
    const tools = await driveForAllowedTools(noToolsConfig, { allowed_tools: ['Read', 'Grep'] });
    expect(tools).toBe('Read,Grep');
  });

  it('an explicit executor profile allowedTools wins over the platform default', async () => {
    const tools = await driveForAllowedTools({ ...noToolsConfig, allowedTools: ['Read'] }, {});
    expect(tools).toBe('Read');
  });

  it('a no-repo (triage) run keeps the empty allowlist — nothing to mutate', async () => {
    const tools = await driveForAllowedTools(noToolsConfig, { workspace_mode: 'none' });
    expect(tools).toBe('');
    expect(prepareMock).not.toHaveBeenCalled();
  });
});

describe('ClaudeCliExecutor — workspace-setup environment (feature 015)', () => {
  const triageProfileConfig = {
    cliPath: 'claude',
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 15,
    killGraceMs: 1000,
    cancelPollMs: 50,
  };
  const setupProfileRow = {
    id: 'setup-exec-1',
    name: 'brigadir-setup',
    config: { cliPath: 'claude', model: 'claude-sonnet-5', maxTurns: 60, killGraceMs: 1000, cancelPollMs: 50 },
    secrets: null,
    enabled: true,
  };
  const wsRepo = { name: 'api', git_url: 'git@acme:api.git', default_branch: 'main' };

  /**
   * Shape-dispatching fake: the joined run-config load returns the agent's
   * (triage) profile + trigger source; plain `where().limit()` selects are
   * dispatched by the requested fields — `value` → global_settings (template),
   * `secrets`/`enabled` → executors (setup profile lookup), else →
   * workspaces.settings. run_events inserts are captured for assertions.
   */
  function fakeSetupDb(opts: {
    source: string | null;
    behavior?: Record<string, unknown>;
    template?: unknown;
    setupProfile?: typeof setupProfileRow | null;
    repositories?: unknown[];
    /** Feature 020: arm the workspace's ticket_scoping flag (D5 — setup runs must ignore it). */
    ticketScoping?: boolean;
  }) {
    const runEventInserts: Record<string, unknown>[] = [];
    const db = {
      runEventInserts,
      select: (fields: Record<string, unknown> = {}) => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      executorConfig: triageProfileConfig,
                      executorName: 'brigadir-orchestrator',
                      executorSecrets: null,
                      behavior: opts.behavior ?? { workspace_mode: 'none' },
                      workspaceId: 'ws-1',
                      triggerEvent: opts.source ? { source: opts.source } : null,
                    },
                  ]),
              }),
            }),
          }),
          where: () => ({
            limit: () => {
              const keys = Object.keys(fields);
              if (keys.includes('value')) {
                return Promise.resolve(opts.template === undefined ? [] : [{ value: opts.template }]);
              }
              if (keys.includes('secrets') || keys.includes('enabled')) {
                return Promise.resolve(opts.setupProfile ? [opts.setupProfile] : []);
              }
              return Promise.resolve([
                {
                  settings: {
                    repositories: opts.repositories ?? [],
                    ...(opts.ticketScoping ? { ticket_scoping: true } : {}),
                  },
                },
              ]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          if (v && 'payload' in v) runEventInserts.push(v);
          // Promise-like enough for both callers: bare-await / .catch()
          // (run_events persists) AND the ensureSetupExecutor chain.
          const settled = Promise.resolve(undefined);
          return {
            then: settled.then.bind(settled),
            catch: settled.catch.bind(settled),
            finally: settled.finally.bind(settled),
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([{ id: setupProfileRow.id }]),
            }),
          };
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    };
    return db;
  }

  /** Only the FR-018 fallback warnings — stream events persist here too. */
  function fallbackEvents(db: { runEventInserts: Record<string, unknown>[] }) {
    return db.runEventInserts.filter(
      (e) => (e.payload as { source?: string } | undefined)?.source === 'setup-profile-fallback',
    );
  }

  function makeSetupExecutor(db: unknown, config: AgentsConfig | null = null) {
    const fakeJira = { getFeatureContext: vi.fn().mockResolvedValue({ linked: [] }) };
    return new ClaudeCliExecutor(db as never, config, fakeJira as never);
  }

  /** Drive one full fake run to completion and return {result, argv}. */
  async function drive(executor: ClaudeCliExecutor, ctx: RunContext) {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const runPromise = executor.run(ctx, new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    for (const line of readFixtureLines('stream-success')) group.child.stdout.write(line + '\n');
    await flush();
    group.child.emit('close', 0, null);
    const result = await runPromise;
    const argv = spawnGroupMock.mock.calls[0][1] as string[];
    return { result, argv };
  }

  let worktreeDir: string;
  beforeEach(async () => {
    worktreeDir = await mkdtemp(join(tmpdir(), 'brigadir-setup-exec-test-'));
    // Feature 023: a setup run is ticketless — there is never prior work to
    // continue, so the worktree is detached at the repo's default branch.
    prepareMock.mockReset().mockResolvedValue(fakeWorkspace(worktreeDir, 'api'));
    cleanupMock.mockReset().mockResolvedValue(undefined);
    spawnGroupMock.mockReset();
  });
  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  it('a workspace-setup run swaps in the setup profile (model, maxTurns) and mounts the default repo on setup/<runId8> (FR-013/020)', async () => {
    const db = fakeSetupDb({
      source: 'workspace-setup',
      setupProfile: setupProfileRow,
      repositories: [wsRepo],
    });
    const executor = makeSetupExecutor(db);

    const { result, argv } = await drive(
      executor,
      makeCtx({ runId: 'a1b2c3d4-e5f6-7890', ticket: null }),
    );

    expect(result.exitStatus).toBe('completed');
    // The setup profile's config won, not the agent's cheap triage profile.
    expect(argv.join(' ')).toContain('--model claude-sonnet-5');
    expect(argv.join(' ')).toContain('--max-turns 60');
    // ST3-768: repo-mounted setup run with no configured tools → platform
    // default toolset (the recon protocol clones repos — it needs git/Bash).
    expect(argv[argv.indexOf('--allowed-tools') + 1]).toBe(
      DEFAULT_REPO_RUN_ALLOWED_TOOLS.join(','),
    );
    // Feature 019 (research D5): a setup run keeps a ONE-element repo scope.
    expect(prepareMock).toHaveBeenCalledTimes(1);
    const [reposArg, runIdArg, , , optsArg] = prepareMock.mock.calls[0];
    expect(reposArg).toHaveLength(1);
    expect(reposArg[0]).toMatchObject({ name: 'api' });
    expect(runIdArg).toBe('a1b2c3d4-e5f6-7890');
    // Feature 023: a ticketless setup run has no chain to continue.
    expect(optsArg.continueBranches).toEqual({});
    const wrapperText = await readFile(join(worktreeDir, '.brigadir', 'wrapper.txt'), 'utf8');
    // Feature 024 (US2): no system-suggested branch name for any run.
    expect(wrapperText).not.toContain('create setup');
    expect(wrapperText).not.toMatch(/— create /);
    // Cleanup rides the standard workspace path (keep flag falsy — success run).
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock.mock.calls[0][0]).toMatchObject({ parentDir: worktreeDir });
    expect(cleanupMock.mock.calls[0][1].keep).toBeFalsy();
    expect(fallbackEvents(db)).toHaveLength(0); // no fallback warning
  });

  it('a workspace-setup run in a flag-ON workspace keeps its one-element scope — the gate never applies (feature 020, D5)', async () => {
    const db = fakeSetupDb({
      source: 'workspace-setup',
      setupProfile: setupProfileRow,
      repositories: [wsRepo, { name: 'extra', git_url: 'git@acme:extra.git', default_branch: 'main' }],
      ticketScoping: true,
    });
    const executor = makeSetupExecutor(db);

    const { result } = await drive(executor, makeCtx({ runId: 'a1b2c3d4-e5f6-7890', ticket: null }));

    expect(result.exitStatus).toBe('completed');
    // Deliberate one-element scope (feature 019, research D5) — untouched by scoping.
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0][0]).toHaveLength(1);
    // No repo-scoping event: the gate structurally never runs for setup runs.
    const scopingRows = db.runEventInserts.filter(
      (e) => (e.payload as { source?: string } | undefined)?.source === 'repo-scoping',
    );
    expect(scopingRows).toHaveLength(0);
  });

  it('a disabled setup executor falls back to the built-in profile and records a run-timeline warning (FR-018)', async () => {
    const db = fakeSetupDb({
      source: 'workspace-setup',
      setupProfile: { ...setupProfileRow, name: 'custom-setup', enabled: false },
      // Template points at the (now disabled) custom profile.
      template: {
        schema_version: 1,
        name: 'brigadir',
        role: 'teamlead',
        timeout_minutes: 45,
        max_budget_usd: null,
        max_attempts: 2,
        enabled: true,
        triage: { executor: 'brigadir-orchestrator', behavior: { workspace_mode: 'none' } },
        setup: { executor: 'custom-setup', behavior: {}, timeout_minutes: 60 },
      },
      repositories: [wsRepo],
    });
    const executor = makeSetupExecutor(db);

    const { result } = await drive(executor, makeCtx({ runId: 'run-fallback-1', ticket: null }));

    expect(result.exitStatus).toBe('completed');
    const events = fallbackEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('log');
    expect(JSON.stringify(events[0].payload)).toContain('custom-setup');
    expect(JSON.stringify(events[0].payload)).toContain('is disabled');
  });

  it('a workspace with no repositories degrades the setup run to the scratch no-repo path (FR-017)', async () => {
    const db = fakeSetupDb({
      source: 'workspace-setup',
      setupProfile: setupProfileRow,
      repositories: [],
    });
    // No yaml fallback either (agentsConfig null).
    const executor = makeSetupExecutor(db, null);

    const { result, argv } = await drive(executor, makeCtx({ runId: 'run-norepo-1', ticket: null }));

    expect(result.exitStatus).toBe('completed');
    expect(prepareMock).not.toHaveBeenCalled(); // scratch dir, no worktree
    // ST3-768: the default toolset is applied AFTER the FR-017 degrade — a
    // setup run without a repository stays as locked-down as a triage run.
    expect(argv[argv.indexOf('--allowed-tools') + 1]).toBe('');
  });

  it('a triage run is byte-identical to before: agent profile, no repository (SC-004/FR-016)', async () => {
    const db = fakeSetupDb({ source: 'triage', behavior: { workspace_mode: 'none' } });
    const executor = makeSetupExecutor(db);

    const { result, argv } = await drive(executor, makeCtx({ runId: 'run-triage-1', ticket: null }));

    expect(result.exitStatus).toBe('completed');
    expect(argv.join(' ')).toContain('--model claude-haiku-4-5-20251001');
    expect(argv.join(' ')).toContain('--max-turns 15');
    expect(prepareMock).not.toHaveBeenCalled();
    expect(fallbackEvents(db)).toHaveLength(0);
  });

  it('a NON-setup ticketless run on a repo-carrying agent is still a config error (guard narrowed, not removed)', async () => {
    const db = fakeSetupDb({ source: 'manual', behavior: {}, repositories: [wsRepo] });
    const executor = makeSetupExecutor(db);

    const result = await executor.run(
      makeCtx({ runId: 'run-guard-1', ticket: null }),
      new AbortController().signal,
    );

    expect(result.exitStatus).toBe('crashed');
    expect(result.diagnostics).toContain('ticketless run requires a no-repository agent');
    expect(prepareMock).not.toHaveBeenCalled();
    expect(spawnGroupMock).not.toHaveBeenCalled();
  });
});

describe('ClaudeCliExecutor ticket scoping (feature 020)', () => {
  const wsRepos = [
    { name: 'product', git_url: 'git@acme:product.git', default_branch: 'main' },
    { name: 'platform', git_url: 'git@acme:platform.git', default_branch: 'main' },
  ];

  let worktreeDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(join(tmpdir(), 'brigadir-executor-scope-'));
    prepareMock.mockReset().mockResolvedValue(fakeWorkspace(worktreeDir));
    cleanupMock.mockReset().mockResolvedValue(undefined);
    spawnGroupMock.mockReset();
  });

  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  const config = { ...executorConfig, repository: undefined };

  function makeScopedExecutor(settings: Record<string, unknown>, behavior: Record<string, unknown> = {}) {
    const db = fakeDb(config, behavior, settings);
    const fakeJira = { getFeatureContext: vi.fn().mockResolvedValue({ linked: [] }) };
    return { executor: new ClaudeCliExecutor(db as never, null, fakeJira as never), db };
  }

  function scopingEvents(db: { insertedEvents: unknown[] }) {
    return (db.insertedEvents as Array<{ payload?: { source?: string } }>).filter(
      (e) => e.payload?.source === 'repo-scoping',
    );
  }

  async function driveToClose(executor: ClaudeCliExecutor, ctx: RunContext) {
    const group = makeGroup();
    spawnGroupMock.mockReturnValue(group);
    const runPromise = executor.run(ctx, new AbortController().signal);
    await waitForSpawn(spawnGroupMock);
    group.child.emit('close', 0, null);
    return runPromise;
  }

  it('flag ON: ticket components narrow the prepared repo set at the call site (D1)', async () => {
    const { executor, db } = makeScopedExecutor({ repositories: wsRepos, ticket_scoping: true });

    await driveToClose(
      executor,
      makeCtx({ ticket: { key: 'BRIG-1', summary: 's', description: '', url: '', components: ['platform', 'Design'] } }),
    );

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect((prepareMock.mock.calls[0][0] as Array<{ name: string }>).map((r) => r.name)).toEqual(['platform']);
    const events = scopingEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: 'run-1',
      type: 'log',
      payload: { source: 'repo-scoping', gate: 'passed', effective: ['platform'], ignored: ['Design'] },
    });
  });

  it('flag ON + no components: typed error BEFORE any worktree work, parked event recorded', async () => {
    const { executor, db } = makeScopedExecutor({ repositories: wsRepos, ticket_scoping: true });

    await expect(
      executor.run(
        makeCtx({ ticket: { key: 'BRIG-2', summary: 's', description: '', url: '', components: [] } }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'RepositoryScopeUndeterminableError', scopeCase: 'no_components' });

    expect(prepareMock).not.toHaveBeenCalled();
    expect(spawnGroupMock).not.toHaveBeenCalled();
    expect(scopingEvents(db)[0]).toMatchObject({ payload: { gate: 'parked:no_components' } });
  });

  it('flag ON + unreadable components (fetch failed): plain fail-closed error, no clone (R5)', async () => {
    const { executor } = makeScopedExecutor({ repositories: wsRepos, ticket_scoping: true });

    await expect(
      executor.run(
        makeCtx({ ticket: { key: 'BRIG-3', summary: 's', description: '', url: '', components: null } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/components could not be read from Jira.*failing closed/);

    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('flag OFF (default): components have no effect and no scoping event is recorded (D2b)', async () => {
    const { executor, db } = makeScopedExecutor({ repositories: wsRepos });

    await driveToClose(
      executor,
      makeCtx({ ticket: { key: 'BRIG-4', summary: 's', description: '', url: '', components: ['platform'] } }),
    );

    expect((prepareMock.mock.calls[0][0] as Array<{ name: string }>).map((r) => r.name)).toEqual([
      'product',
      'platform',
    ]);
    expect(scopingEvents(db)).toHaveLength(0);
  });

  it('flag ON + single-repo base set: gate skipped, run proceeds regardless of components (D2a)', async () => {
    const { executor, db } = makeScopedExecutor(
      { repositories: wsRepos, ticket_scoping: true },
      { repositories: ['product'] },
    );

    await driveToClose(
      executor,
      makeCtx({ ticket: { key: 'BRIG-5', summary: 's', description: '', url: '', components: [] } }),
    );

    expect((prepareMock.mock.calls[0][0] as Array<{ name: string }>).map((r) => r.name)).toEqual(['product']);
    expect(scopingEvents(db)[0]).toMatchObject({ payload: { gate: 'skipped_single_repo' } });
  });

  it('flag ON + ticketless no-repo run: scoping bypassed entirely (FR-014)', async () => {
    const { executor, db } = makeScopedExecutor(
      { repositories: wsRepos, ticket_scoping: true },
      { workspace_mode: 'none' },
    );

    const result = await driveToClose(executor, makeCtx({ ticket: null }));

    expect(result.exitStatus).toBe('crashed'); // no terminal event driven — irrelevant here
    expect(prepareMock).not.toHaveBeenCalled();
    expect(scopingEvents(db)).toHaveLength(0);
  });
});

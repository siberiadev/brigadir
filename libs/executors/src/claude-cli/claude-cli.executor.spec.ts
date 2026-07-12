import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentsConfig } from '@brigadir/contracts';
import type { RunContext } from '../agent-executor.interface';

vi.mock('./worktree', () => ({
  prepare: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('./process-group', () => ({
  spawnGroup: vi.fn(),
}));

import { prepare, cleanup } from './worktree';
import { spawnGroup } from './process-group';
import { ClaudeCliExecutor } from './claude-cli.executor';

const prepareMock = prepare as unknown as ReturnType<typeof vi.fn>;
const cleanupMock = cleanup as unknown as ReturnType<typeof vi.fn>;
const spawnGroupMock = spawnGroup as unknown as ReturnType<typeof vi.fn>;

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

function fakeDb(executorConfig: unknown, behavior: unknown) {
  return {
    select: () => ({
      // Two select shapes: the run-config load (innerJoin chain) and the
      // feature-005 workspace-settings read (plain where().limit() — returns
      // empty settings so these tests keep resolving repos via the yaml path).
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ executorConfig, behavior, workspaceId: 'ws-1' }]),
            }),
          }),
        }),
        where: () => ({
          limit: () => Promise.resolve([{ settings: {} }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve(),
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
  killGraceMs: 50,
  cancelPollMs: 50,
};

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-1',
    ticket: { key: 'BRIG-1', summary: 'Test ticket', description: '', url: '' },
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
    prepareMock.mockReset().mockResolvedValue({
      worktreeDir,
      branch: 'feat/BRIG-1',
      cacheDir: join(worktreeDir, '..', 'cache'),
    });
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
    expect(cleanupMock).toHaveBeenCalledWith(expect.any(String), worktreeDir, { keep: false });
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
    expect(group.terminate).toHaveBeenCalledWith(50);
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

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

const execFileAsync = promisify(execFile);

export const FAKE_CLI_PATH = join(process.cwd(), 'test', 'fixtures', 'claude-cli', 'fake-claude.mjs');

export interface ClaudeCliTestEnv {
  root: string;
  remoteDir: string;
  worktreeRoot: string;
  repoCacheRoot: string;
  agentsConfigPath: string;
  cleanup: () => Promise<void>;
}

async function initRemote(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main', dir]);
  await writeFile(join(dir, 'README.md'), '# claude_cli integration test repo\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'],
    { cwd: dir },
  );
}

/**
 * One self-contained temp environment per test suite: a real local git
 * "remote" (no network, per D8/D3's own unit-test pattern), scratch
 * worktree/cache roots, and a generated `agents.yaml` declaring both a
 * `mock` and a `claude_cli` executor (so `QueuesModule.register()` — which
 * reads this file at `WorkerAppModule` decorator-argument-evaluation time —
 * provisions both `run.mock` and `run.claude_cli` queues).
 *
 * The yaml's `claude_cli` executor block only needs to be *structurally*
 * valid (AgentsConfigSchema boot validation) — the actual per-run config
 * (cliPath, repository, allowedTools, worktree roots, ...) that
 * `ClaudeCliExecutor` uses comes from `executors.config` (DB jsonb), seeded
 * directly via `seedPipeline`'s `executorConfig` option, independent of this
 * file's own executor entries.
 */
export async function setupClaudeCliTestEnv(): Promise<ClaudeCliTestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'brigadir-claude-cli-it-'));
  const remoteDir = join(root, 'remote');
  const worktreeRoot = join(root, 'worktrees');
  const repoCacheRoot = join(root, 'repos');
  await initRemote(remoteDir);

  const agentsConfig = {
    workspace: {
      jira_site: 'https://acme.atlassian.net',
      project_key: 'BRIG',
      board_id: 42,
      default_branch: 'main',
      repositories: [{ name: 'product', url: remoteDir, default_branch: 'main' }],
    },
    executors: {
      'mock-exec': { type: 'mock', concurrency: 2 },
      coder: { type: 'claude_cli', model: 'claude-sonnet-5', repository: 'product', concurrency: 2 },
    },
    agents: [
      {
        name: 'mock-agent',
        executor: 'mock-exec',
        instruction: 'placeholder',
        status_success: 'Code Review',
        status_failure: 'Blocked',
      },
      {
        name: 'coder-agent',
        executor: 'coder',
        instruction: 'placeholder',
        status_success: 'Code Review',
        status_failure: 'Blocked',
        behavior: { allowed_tools: ['Read'] },
      },
    ],
  };

  const agentsConfigPath = join(root, 'agents.yaml');
  await writeFile(agentsConfigPath, stringify(agentsConfig));

  return {
    root,
    remoteDir,
    worktreeRoot,
    repoCacheRoot,
    agentsConfigPath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The `executors.config` (DB jsonb) `ClaudeCliExecutor` actually reads at runtime. */
export function baseExecutorConfig(
  env: ClaudeCliTestEnv,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cliPath: FAKE_CLI_PATH,
    model: 'claude-sonnet-5',
    repository: 'product',
    allowedTools: ['Read', 'Edit', 'Bash(git *)'],
    keepFailedWorktrees: false,
    worktreeRoot: env.worktreeRoot,
    repoCacheRoot: env.repoCacheRoot,
    killGraceMs: 500,
    cancelPollMs: 200,
    ...overrides,
  };
}

/** Clears every `FAKE_CLAUDE_*` control var so tests don't leak state into each other. */
export function resetFakeClaudeEnv(): void {
  delete process.env.FAKE_CLAUDE_FIXTURE;
  delete process.env.FAKE_CLAUDE_ENV_DUMP;
  delete process.env.FAKE_CLAUDE_ARGV_DUMP;
  delete process.env.FAKE_CLAUDE_SPAWN_CHILD;
  delete process.env.FAKE_CLAUDE_CHILD_PID_FILE;
  delete process.env.FAKE_CLAUDE_SELF_PID_FILE;
  delete process.env.FAKE_CLAUDE_STDERR_TEXT;
  delete process.env.FAKE_CLAUDE_EXIT_CODE;
  delete process.env.FAKE_CLAUDE_LINE_DELAY_MS;
  delete process.env.FAKE_CLAUDE_CALLBACKS;
}

/**
 * One scripted step the fake CLI plays (T096): an HTTP callback against the
 * real callback API, a linger (`sleep`), or an ndjson fixture emitted to
 * stdout mid-sequence (`stream` — models the real CLI printing its terminal
 * result event AFTER the agent's callbacks).
 */
export type FakeClaudeCallbackStep =
  | { tool: 'progress' | 'human' | 'complete'; body: Record<string, unknown> }
  | { tool: 'sleep'; ms: number }
  | { tool: 'stream'; fixture: string }
  // Feature 024: make a real commit in a repo's worktree (moves HEAD past the
  // recorded start SHA) to exercise the completion gate.
  | { tool: 'commit'; repo: string; file?: string };

/** Sets FAKE_CLAUDE_CALLBACKS so the fake CLI plays this scripted sequence (quickstart.md pattern 1). */
export function setFakeClaudeCallbacks(steps: FakeClaudeCallbackStep[]): void {
  process.env.FAKE_CLAUDE_CALLBACKS = JSON.stringify(steps);
}

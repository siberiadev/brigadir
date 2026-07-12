import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeCliConfig, type ClaudeCliExecutorConfig } from './claude-cli.config';

const base: ClaudeCliExecutorConfig = {
  type: 'claude_cli',
  concurrency: 2,
  model: 'claude-sonnet-5',
  cliPath: 'claude',
  repository: 'product',
  keepFailedWorktrees: false,
  killGraceMs: 5000,
  cancelPollMs: 3000,
  useCallbackChannel: false,
};

describe('resolveClaudeCliConfig (T076)', () => {
  it('resolves omitted optional fields to their documented defaults', () => {
    const runtime = resolveClaudeCliConfig(base, ['Read', 'Edit']);
    expect(runtime.worktreeRoot).toBe(join(tmpdir(), 'brigadir', 'worktrees'));
    expect(runtime.repoCacheRoot).toBe(join(tmpdir(), 'brigadir', 'repos'));
    expect(runtime.allowedTools).toEqual(['Read', 'Edit']);
    expect(runtime.maxTurns).toBeUndefined();
  });

  it('an explicit value always wins over the default', () => {
    const runtime = resolveClaudeCliConfig(
      {
        ...base,
        allowedTools: ['Bash(git *)'],
        worktreeRoot: '/custom/worktrees',
        repoCacheRoot: '/custom/repos',
        maxTurns: 40,
      },
      ['Read', 'Edit'],
    );
    expect(runtime.worktreeRoot).toBe('/custom/worktrees');
    expect(runtime.repoCacheRoot).toBe('/custom/repos');
    expect(runtime.allowedTools).toEqual(['Bash(git *)']);
    expect(runtime.maxTurns).toBe(40);
  });

  it('falls back to the agent behavior.allowed_tools when the executor declares none', () => {
    const runtime = resolveClaudeCliConfig({ ...base, allowedTools: [] }, ['Grep']);
    expect(runtime.allowedTools).toEqual(['Grep']);
  });

  it('defaults allowedTools to an empty array when neither source declares any', () => {
    const runtime = resolveClaudeCliConfig(base);
    expect(runtime.allowedTools).toEqual([]);
  });

  it('resolves useCallbackChannel true (T097, D6 — explicit config, not implicit magic)', () => {
    const runtime = resolveClaudeCliConfig({ ...base, useCallbackChannel: true });
    expect(runtime.useCallbackChannel).toBe(true);
  });

  it('resolves useCallbackChannel false when omitted', () => {
    const runtime = resolveClaudeCliConfig(base);
    expect(runtime.useCallbackChannel).toBe(false);
  });
});

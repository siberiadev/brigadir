import { describe, it, expect } from 'vitest';
import { ClaudeCliExecutor } from './claude-cli/claude-cli.executor';
import { MOONSHOT_ANTHROPIC_BASE_URL } from './claude-cli/claude-cli.config';
import { ExecutorRegistry } from './executor.registry';

/**
 * Feature 025 (T012) — the two-instances-one-class registration contract.
 * These tests instantiate ClaudeCliExecutor exactly the way ExecutorsModule's
 * providers do (bare = claude_cli default preset; explicit Moonshot preset =
 * kimi) and prove the registry resolves each by its type. The DB/config/Jira
 * deps are never touched by construction, so nulls suffice.
 */

function bareInstance(): ClaudeCliExecutor {
  return new ClaudeCliExecutor(null as never, null, null as never);
}

function kimiInstance(): ClaudeCliExecutor {
  return new ClaudeCliExecutor(null as never, null, null as never, {
    type: 'kimi',
    anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL,
  });
}

describe('ClaudeCliExecutor provider preset (feature 025)', () => {
  it('defaults to the claude_cli type with no preset — pre-025 class-provider behavior', () => {
    expect(bareInstance().type).toBe('claude_cli');
  });

  it('takes its type from the kimi preset', () => {
    expect(kimiInstance().type).toBe('kimi');
  });
});

describe('ExecutorRegistry with both harness instances (feature 025)', () => {
  it('resolves claude_cli and kimi to their own instances', () => {
    const claudeCli = bareInstance();
    const kimi = kimiInstance();
    const registry = new ExecutorRegistry([claudeCli, kimi]);
    expect(registry.resolve('claude_cli')).toBe(claudeCli);
    expect(registry.resolve('kimi')).toBe(kimi);
    expect(registry.has('kimi')).toBe(true);
  });
});

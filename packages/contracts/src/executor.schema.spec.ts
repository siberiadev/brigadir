import { describe, it, expect } from 'vitest';
import { ExecutorApiConfigSchema as ExecutorConfigSchema } from './executor.schema';

/**
 * T004 (Constitution VI — typed-config validation is pipeline logic). The
 * discriminated union is the shared authority for backend validation and the
 * Vue form, so its accept/reject behavior is unit-pinned here.
 */
describe('ExecutorConfigSchema (executor typed config union)', () => {
  it('accepts a valid mock config (concurrency only)', () => {
    const parsed = ExecutorConfigSchema.safeParse({ type: 'mock', concurrency_limit: 2 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid claude_cli config (all fields)', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'claude_cli',
      model: 'claude-opus-4-8',
      cli_path: 'claude',
      use_callback_channel: true,
      keep_failed_worktrees: false,
      max_turns: 40,
      concurrency_limit: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects repository on claude_cli — it moved to agents.behavior (platform-scoped executors)', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'claude_cli',
      model: 'claude-opus-4-8',
      cli_path: 'claude',
      repository: 'api',
      use_callback_channel: true,
      keep_failed_worktrees: false,
      max_turns: 40,
      concurrency_limit: 2,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a foreign field (mock carrying max_turns)', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'mock',
      concurrency_limit: 2,
      max_turns: 40,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing required claude_cli fields', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'claude_cli',
      model: 'claude-opus-4-8',
      concurrency_limit: 2,
      // cli_path, use_callback_channel, keep_failed_worktrees, max_turns missing
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown executor type', () => {
    const parsed = ExecutorConfigSchema.safeParse({ type: 'anthropic_api', concurrency_limit: 2 });
    expect(parsed.success).toBe(false);
  });
});

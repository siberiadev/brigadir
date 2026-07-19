import { describe, it, expect } from 'vitest';
import { ClaudeCliExecutor } from './claude-cli/claude-cli.executor';
import {
  applyAuthEnv,
  applyProviderEnv,
  MOONSHOT_ANTHROPIC_BASE_URL,
  type EffectiveAuth,
} from './claude-cli/claude-cli.config';
import { buildChildEnv } from './claude-cli/env-allowlist';
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

/**
 * T020 (US2 unit half, SC-002): the claude_cli child-env construction is
 * byte-identical with the provider step in place — for every auth mode, the
 * full post-025 sequence (buildChildEnv → applyAuthEnv → applyProviderEnv
 * with the claude_cli preset) deep-equals the pre-025 sequence (no provider
 * step), and the base-URL key is entirely absent.
 */
describe('claude_cli env construction unchanged by the provider step (feature 025, T020)', () => {
  const source = {
    HOME: '/home/op',
    PATH: '/usr/bin',
    USER: 'op',
    ANTHROPIC_BASE_URL: 'https://host-canary.example.com',
    ANTHROPIC_API_KEY: 'sk-host-canary',
  } as NodeJS.ProcessEnv;

  const cases: { auth: EffectiveAuth; apiKey?: string }[] = [
    { auth: { mode: 'host_subscription' } },
    { auth: { mode: 'api_key' }, apiKey: 'sk-profile' },
    {
      auth: { mode: 'bedrock', awsRegion: 'eu-west-1', awsProfile: 'corp', caBundlePath: '/ca.pem' },
    },
  ];

  for (const { auth, apiKey } of cases) {
    it(`auth mode "${auth.mode}"`, () => {
      const pre025 = buildChildEnv(source);
      applyAuthEnv(pre025, auth, apiKey);

      const post025 = buildChildEnv(source);
      applyAuthEnv(post025, auth, apiKey);
      applyProviderEnv(post025, { type: 'claude_cli' });

      expect(post025).toEqual(pre025);
      expect('ANTHROPIC_BASE_URL' in post025).toBe(false);
    });
  }
});

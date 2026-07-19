import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveClaudeCliConfig,
  resolveEffectiveAuth,
  applyAuthEnv,
  applyProviderEnv,
  MOONSHOT_ANTHROPIC_BASE_URL,
  type ClaudeCliExecutorConfig,
} from './claude-cli.config';

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
    // Under ~/.brigadir, never $TMPDIR — the macOS reaper guts both roots there
    // (incident 2026-07-18); see resolveClaudeCliConfig.
    expect(runtime.worktreeRoot).toBe(join(homedir(), '.brigadir', 'worktrees'));
    expect(runtime.repoCacheRoot).toBe(join(homedir(), '.brigadir', 'repos'));
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

/**
 * Feature 018 (T006) — the defaulting rule matrix. This is THE implementation
 * both the runtime and the dashboard response mapper share; every legacy
 * combination must land exactly where the pre-018 behavior did (SC-002).
 */
describe('resolveEffectiveAuth (feature 018)', () => {
  it('legacy row (no auth): stored key → api_key, no key → host_subscription', () => {
    expect(resolveEffectiveAuth({}, true)).toEqual({ mode: 'api_key' });
    expect(resolveEffectiveAuth({}, false)).toEqual({ mode: 'host_subscription' });
  });

  it('explicit auth always wins over the stored-key heuristic', () => {
    expect(resolveEffectiveAuth({ auth: 'host_subscription' }, true)).toEqual({
      mode: 'host_subscription',
    });
    expect(resolveEffectiveAuth({ auth: 'api_key' }, false)).toEqual({ mode: 'api_key' });
    expect(resolveEffectiveAuth({ auth: 'api_key' }, true)).toEqual({ mode: 'api_key' });
  });

  it('bedrock carries the region and optional fields through (with or without a stored key)', () => {
    expect(
      resolveEffectiveAuth(
        { auth: 'bedrock', awsRegion: 'eu-west-1', awsProfile: 'corp', caBundlePath: '/ca.pem' },
        true,
      ),
    ).toEqual({ mode: 'bedrock', awsRegion: 'eu-west-1', awsProfile: 'corp', caBundlePath: '/ca.pem' });
    expect(resolveEffectiveAuth({ auth: 'bedrock', awsRegion: 'us-east-1' }, false)).toEqual({
      mode: 'bedrock',
      awsRegion: 'us-east-1',
      awsProfile: undefined,
      caBundlePath: undefined,
    });
  });

  it('bedrock without a region fails loud (hand-edited jsonb) — never a silent mode fallback', () => {
    expect(() => resolveEffectiveAuth({ auth: 'bedrock' }, false)).toThrow(/awsRegion/);
  });
});

/**
 * Feature 018 (T006) — the exact per-mode injection matrix (SC-003's unit
 * half; the integration half rides the fake-claude env dump). The env passed
 * in is the ALREADY-allowlisted floor; applyAuthEnv may only add the mode's
 * documented keys and must never drop what the floor granted.
 */
describe('applyAuthEnv (feature 018)', () => {
  const floor = () => ({ HOME: '/home/op', PATH: '/usr/bin', USER: 'op' });

  it('host_subscription injects nothing', () => {
    const env = floor();
    applyAuthEnv(env, { mode: 'host_subscription' });
    expect(env).toEqual(floor());
  });

  it('api_key injects exactly ANTHROPIC_API_KEY (and nothing without a decrypted key)', () => {
    const env = floor();
    applyAuthEnv(env, { mode: 'api_key' }, 'sk-profile');
    expect(env).toEqual({ ...floor(), ANTHROPIC_API_KEY: 'sk-profile' });

    const bare = floor();
    applyAuthEnv(bare, { mode: 'api_key' });
    expect(bare).toEqual(floor());
  });

  it('bedrock (full) injects exactly the four documented keys with profile values', () => {
    const env = floor();
    applyAuthEnv(env, {
      mode: 'bedrock',
      awsRegion: 'eu-west-1',
      awsProfile: 'corp-dev',
      caBundlePath: '/etc/ssl/corp/ca-bundle.pem',
    });
    expect(env).toEqual({
      ...floor(),
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'eu-west-1',
      AWS_PROFILE: 'corp-dev',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp/ca-bundle.pem',
    });
  });

  it('bedrock (region only) omits AWS_PROFILE and NODE_EXTRA_CA_CERTS — AWS default chain', () => {
    const env = floor();
    applyAuthEnv(env, { mode: 'bedrock', awsRegion: 'us-east-1' });
    expect(env).toEqual({ ...floor(), CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' });
  });

  it('bedrock never injects an ANTHROPIC_API_KEY even when an (inert) decrypted key is passed', () => {
    // Defense in depth for FR-009: the executor must not decrypt outside
    // api_key mode, and even if it did, bedrock injection stays key-free.
    const env = floor();
    applyAuthEnv(env, { mode: 'bedrock', awsRegion: 'eu-west-1' }, 'sk-should-be-inert');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

/**
 * Feature 025 — provider-endpoint injection matrix (contracts/
 * kimi-provider-env.md invariants 2 and 6; the integration half rides the
 * fake-claude env dump). The env passed in is the ALREADY-allowlisted floor;
 * applyProviderEnv may only add ANTHROPIC_BASE_URL from the preset, and for
 * the claude_cli preset it must leave the object byte-identical.
 */
describe('applyProviderEnv (feature 025)', () => {
  const floor = () => ({ HOME: '/home/op', PATH: '/usr/bin', USER: 'op' });

  it('kimi preset injects exactly the Moonshot ANTHROPIC_BASE_URL constant', () => {
    const env = floor();
    applyProviderEnv(env, { type: 'kimi', anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL });
    expect(env).toEqual({ ...floor(), ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' });
  });

  it('claude_cli preset (no base URL) is a byte-identical no-op — the key is entirely absent', () => {
    const env = floor();
    applyProviderEnv(env, { type: 'claude_cli' });
    expect(env).toEqual(floor());
    expect('ANTHROPIC_BASE_URL' in env).toBe(false);
  });

  it('is pure — the value comes from the preset only, never from the host process.env', () => {
    const original = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example.com';
    try {
      const env = floor();
      applyProviderEnv(env, { type: 'claude_cli' });
      expect('ANTHROPIC_BASE_URL' in env).toBe(false);

      const kimiEnv = floor();
      applyProviderEnv(kimiEnv, { type: 'kimi', anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL });
      expect(kimiEnv.ANTHROPIC_BASE_URL).toBe(MOONSHOT_ANTHROPIC_BASE_URL);
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = original;
    }
  });

  it('stacks on top of api_key auth injection without touching it (kimi run order)', () => {
    const env = floor();
    applyAuthEnv(env, { mode: 'api_key' }, 'sk-moonshot-profile');
    applyProviderEnv(env, { type: 'kimi', anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL });
    expect(env).toEqual({
      ...floor(),
      ANTHROPIC_API_KEY: 'sk-moonshot-profile',
      ANTHROPIC_BASE_URL: MOONSHOT_ANTHROPIC_BASE_URL,
    });
  });
});

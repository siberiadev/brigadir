import { describe, it, expect } from 'vitest';
import { buildChildEnv } from './env-allowlist';

const CANARY_SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-canary-1',
  ANTHROPIC_AUTH_TOKEN: 'canary-auth-token',
  AWS_SECRET_ACCESS_KEY: 'aws-canary-secret',
  AWS_ACCESS_KEY_ID: 'aws-canary-key-id',
  GCP_SERVICE_ACCOUNT_KEY: 'gcp-canary-key',
  OPENAI_API_KEY: 'sk-openai-canary',
  JIRA_API_TOKEN: 'jira-canary-token',
  DATABASE_URL: 'postgres://user:pass@host/db',
  REDIS_URL: 'redis://user:pass@host:6379',
  SOME_RANDOM_TOKEN: 'random-canary-token',
  SOME_RANDOM_SECRET: 'random-canary-secret',
};

const ALLOWLISTED = {
  HOME: '/home/op',
  PATH: '/usr/bin:/bin',
  USER: 'op',
  LOGNAME: 'op',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp',
  GIT_AUTHOR_NAME: 'Brigadir Bot',
  GIT_AUTHOR_EMAIL: 'bot@example.com',
  GIT_COMMITTER_NAME: 'Brigadir Bot',
  GIT_COMMITTER_EMAIL: 'bot@example.com',
};

describe('buildChildEnv (T078)', () => {
  it('contains 0 of the canary secrets and all of the allowlisted keys', () => {
    const source = { ...CANARY_SECRETS, ...ALLOWLISTED };
    const env = buildChildEnv(source);

    for (const key of Object.keys(CANARY_SECRETS)) {
      expect(env[key]).toBeUndefined();
    }
    for (const [key, value] of Object.entries(ALLOWLISTED)) {
      expect(env[key]).toBe(value);
    }
  });

  it('never spreads unlisted keys through, even ones with a benign-looking name', () => {
    const env = buildChildEnv({ RANDOM_UNLISTED_VAR: 'x', HOME: '/home/op' });
    expect(Object.keys(env)).toEqual(['HOME']);
  });

  it('skips allowlisted keys that are simply absent from the source', () => {
    const env = buildChildEnv({ HOME: '/home/op' });
    expect(env).toEqual({ HOME: '/home/op' });
  });

  it('passes through the fake-CLI test-harness control vars', () => {
    const env = buildChildEnv({
      FAKE_CLAUDE_FIXTURE: 'stream-success',
      FAKE_CLAUDE_ENV_DUMP: '/tmp/env.json',
    });
    expect(env.FAKE_CLAUDE_FIXTURE).toBe('stream-success');
    expect(env.FAKE_CLAUDE_ENV_DUMP).toBe('/tmp/env.json');
  });
});

/**
 * Feature 025 (T023, US4): lock the floor — the provider/auth variables are
 * injected per-run AFTER the allowlist pass (from profile/preset values) and
 * must never become allowlisted, or a host-level value could silently
 * redirect any run's traffic or billing. This is a deliberate negative pin:
 * if someone tries to "fix" a kimi/auth issue by extending the allowlist,
 * this test is the tripwire.
 */
describe('allowlist floor lock (feature 025, T023)', () => {
  it('never passes provider endpoint or credential variables through, even when the host sets them', () => {
    const forbidden = [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
    ];
    const source: NodeJS.ProcessEnv = { HOME: '/home/op' };
    for (const key of forbidden) source[key] = `canary-${key}`;
    const env = buildChildEnv(source);
    for (const key of forbidden) {
      expect(env[key], key).toBeUndefined();
    }
    expect(Object.keys(env)).toEqual(['HOME']);
  });
});

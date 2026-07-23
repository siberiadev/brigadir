import { describe, it, expect } from 'vitest';
import { gitAuthEnv } from './git-auth';

const TOKEN = 'ghp_secret_token_value';

describe('gitAuthEnv', () => {
  it('delivers an https token as an Authorization header via GIT_CONFIG_* env (never argv)', () => {
    const env = gitAuthEnv('https://github.com/acme/agents.git', TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    const expected = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${expected}`);
    // The raw token is never a bare env value — it is only inside the b64 header.
    expect(Object.values(env)).not.toContain(TOKEN);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('returns no auth env for ssh remotes (token is a no-op there)', () => {
    expect(gitAuthEnv('git@github.com:acme/agents.git', TOKEN)).toEqual({});
    expect(gitAuthEnv('ssh://git@github.com/acme/agents.git', TOKEN)).toEqual({});
  });

  it('returns no auth env when there is no token', () => {
    expect(gitAuthEnv('https://github.com/acme/agents.git', undefined)).toEqual({});
    expect(gitAuthEnv('https://github.com/acme/agents.git', '')).toEqual({});
  });
});

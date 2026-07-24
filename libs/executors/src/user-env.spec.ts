import { describe, it, expect } from 'vitest';
import { composeUserEnv, applyUserEnv, assembleRunUserEnv } from './user-env';

describe('composeUserEnv (feature 031 precedence)', () => {
  it('layers workspace < repo < agent for the same key', () => {
    const merged = composeUserEnv({
      workspaceEnv: { NODE_ENV: 'test', SHARED: 'ws' },
      repoEnvs: [{ NODE_ENV: 'repo', PORT: '3100' }],
      agentEnv: { NODE_ENV: 'agent' },
    });
    expect(merged.NODE_ENV).toBe('agent'); // agent wins
    expect(merged.PORT).toBe('3100'); // repo-only survives
    expect(merged.SHARED).toBe('ws'); // workspace-only survives
  });

  it('lets a later-mounted repo win a key collision (mount order)', () => {
    const merged = composeUserEnv({
      repoEnvs: [
        { DB: 'first', A: '1' },
        { DB: 'second', B: '2' },
      ],
    });
    expect(merged.DB).toBe('second');
    expect(merged.A).toBe('1');
    expect(merged.B).toBe('2');
  });

  it('returns an empty object when no layers are provided', () => {
    expect(composeUserEnv({})).toEqual({});
  });

  it('preserves empty-string values (KEY= is not unset)', () => {
    const merged = composeUserEnv({ workspaceEnv: { EMPTY: '' } });
    expect(merged.EMPTY).toBe('');
    expect('EMPTY' in merged).toBe(true);
  });
});

describe('applyUserEnv (feature 031 injection)', () => {
  it('mutates the child env in place and reports no drops for clean keys', () => {
    const env: Record<string, string> = { HOME: '/home/agent' };
    const dropped = applyUserEnv(env, { NODE_ENV: 'test', PORT: '3100', EMPTY: '' });
    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe('3100');
    expect(env.EMPTY).toBe('');
    expect(env.HOME).toBe('/home/agent'); // untouched
    expect(dropped).toEqual([]);
  });

  it('drops platform-reserved keys and reports them (defense-in-depth)', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const dropped = applyUserEnv(env, {
      ANTHROPIC_API_KEY: 'sneaky',
      AWS_SECRET_ACCESS_KEY: 'sneaky',
      PATH: '/evil',
      SSH_AUTH_SOCK: '/evil.sock',
      BRIGADIR_DASHBOARD_TOKEN: 'sneaky',
      SAFE: 'ok',
    });
    expect(env.SAFE).toBe('ok');
    expect(env.PATH).toBe('/usr/bin'); // reserved — original wins, not overwritten
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBe(undefined);
    expect(dropped).toContain('ANTHROPIC_API_KEY');
    expect(dropped).toContain('AWS_SECRET_ACCESS_KEY');
    expect(dropped).toContain('PATH');
    expect(dropped).toContain('SSH_AUTH_SOCK');
    expect(dropped).toContain('BRIGADIR_DASHBOARD_TOKEN');
    expect(dropped).not.toContain('SAFE');
  });
});

describe('assembleRunUserEnv (feature 031 — secret + plaintext merge)', () => {
  it('merges secret and non-secret at each scope and surfaces secret values', () => {
    const { userEnv, secretValues } = assembleRunUserEnv({
      workspaceEnv: { WS_PLAIN: 'a' },
      agentEnv: { AG_PLAIN: 'd' },
      mountedRepos: [{ id: 'r1', env: { REPO_PLAIN: 'b' } }],
      agentId: 'agent-1',
      secrets: {
        workspace: { WS_SECRET: 'sw' },
        repos: { r1: { REPO_SECRET: 'sr' } },
        agents: { 'agent-1': { AG_SECRET: 'sa' } },
      },
    });
    expect(userEnv).toMatchObject({
      WS_PLAIN: 'a',
      WS_SECRET: 'sw',
      REPO_PLAIN: 'b',
      REPO_SECRET: 'sr',
      AG_PLAIN: 'd',
      AG_SECRET: 'sa',
    });
    expect(secretValues.sort()).toEqual(['sa', 'sr', 'sw']);
  });

  it('applies scope precedence across secret values too (agent secret beats repo secret)', () => {
    const { userEnv } = assembleRunUserEnv({
      mountedRepos: [{ id: 'r1', env: {} }],
      agentId: 'a1',
      secrets: { repos: { r1: { TOKEN: 'repo' } }, agents: { a1: { TOKEN: 'agent' } } },
    });
    expect(userEnv.TOKEN).toBe('agent');
  });

  it('ignores repo secrets when the mounted repo has no id', () => {
    const { userEnv, secretValues } = assembleRunUserEnv({
      mountedRepos: [{ env: { PLAIN: 'x' } }],
      secrets: { repos: { 'some-id': { SECRET: 's' } } },
    });
    expect(userEnv).toEqual({ PLAIN: 'x' });
    expect(secretValues).toEqual([]);
  });
});

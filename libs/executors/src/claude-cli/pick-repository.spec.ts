import { describe, it, expect } from 'vitest';
import { pickWorkspaceRepository, resolveRepositoryName } from './claude-cli.executor';

const dbRepos = [
  { name: 'product', git_url: 'git@github.com:acme/product.git', default_branch: 'main' },
  { name: 'infra', git_url: 'git@github.com:acme/infra.git', default_branch: 'master' },
];
const yamlRepos = [
  { name: 'product', url: 'git@github.com:legacy/product.git', default_branch: 'legacy' },
];

describe('pickWorkspaceRepository (feature 005 checkpoint fix — DB settings win over yaml)', () => {
  it('prefers workspace settings.repositories over agents.yaml for the same name', () => {
    const repo = pickWorkspaceRepository(dbRepos, yamlRepos, 'product', true);
    expect(repo.url).toBe('git@github.com:acme/product.git');
    expect(repo.defaultBranch).toBe('main');
  });

  it('empty name resolves the workspace default (first DB entry)', () => {
    const repo = pickWorkspaceRepository(dbRepos, yamlRepos, '', true);
    expect(repo.name).toBe('product');
  });

  it('unknown name against DB repos fails loud (no silent yaml fallthrough)', () => {
    expect(() => pickWorkspaceRepository(dbRepos, yamlRepos, 'ghost', true)).toThrow(
      /no repository named "ghost" in settings.repositories/,
    );
  });

  it('falls back to yaml when settings has no repositories (legacy yaml-imported setup)', () => {
    const repo = pickWorkspaceRepository([], yamlRepos, 'product', true);
    expect(repo.url).toBe('git@github.com:legacy/product.git');
  });

  it('no settings repos and no yaml → clear diagnostic naming the missing source', () => {
    expect(() => pickWorkspaceRepository([], [], 'product', false)).toThrow(/no agents.yaml is loaded/);
    expect(() => pickWorkspaceRepository([], [], '', true)).toThrow(/does not define it either/);
  });
});

describe('resolveRepositoryName (platform-scoped executors, 2026-07-13 — repository is the AGENT choice)', () => {
  it('behavior.repository wins when set', () => {
    expect(resolveRepositoryName({ repository: 'infra' })).toBe('infra');
    expect(pickWorkspaceRepository(dbRepos, [], resolveRepositoryName({ repository: 'infra' }), false).name).toBe(
      'infra',
    );
  });

  it('absent behavior.repository → the workspace default (first settings entry)', () => {
    expect(resolveRepositoryName({})).toBe('');
    expect(pickWorkspaceRepository(dbRepos, [], resolveRepositoryName({}), false).name).toBe('product');
  });

  it('non-string junk in behavior.repository degrades to the workspace default, never crashes', () => {
    expect(resolveRepositoryName({ repository: 42 })).toBe('');
    expect(resolveRepositoryName({ repository: null })).toBe('');
  });
});

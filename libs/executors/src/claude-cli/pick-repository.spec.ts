import { describe, it, expect } from 'vitest';
import { pickWorkspaceRepositories, resolveRepositoryNames } from './claude-cli.executor';

const dbRepos = [
  { name: 'product', git_url: 'git@github.com:acme/product.git', default_branch: 'main' },
  { name: 'infra', git_url: 'git@github.com:acme/infra.git', default_branch: 'master' },
];
const yamlRepos = [
  { name: 'product', url: 'git@github.com:legacy/product.git', default_branch: 'legacy' },
];

describe('pickWorkspaceRepositories (feature 005 DB-wins + feature 019 list semantics)', () => {
  it('prefers workspace settings.repositories over agents.yaml for the same name', () => {
    const repos = pickWorkspaceRepositories(dbRepos, yamlRepos, ['product'], true);
    expect(repos).toHaveLength(1);
    expect(repos[0].url).toBe('git@github.com:acme/product.git');
    expect(repos[0].defaultBranch).toBe('main');
  });

  it('empty name list resolves ALL workspace repositories in declaration order (research D1)', () => {
    const repos = pickWorkspaceRepositories(dbRepos, yamlRepos, [], true);
    expect(repos.map((r) => r.name)).toEqual(['product', 'infra']);
  });

  it('a subset list filters, keeping WORKSPACE declaration order (the list selects, the workspace orders)', () => {
    const repos = pickWorkspaceRepositories(dbRepos, yamlRepos, ['infra', 'product'], true);
    expect(repos.map((r) => r.name)).toEqual(['product', 'infra']);
  });

  it('unknown name against DB repos fails loud (no silent yaml fallthrough)', () => {
    expect(() => pickWorkspaceRepositories(dbRepos, yamlRepos, ['ghost'], true)).toThrow(
      /no repository named "ghost" in settings.repositories/,
    );
    // ...even when mixed with valid names — all-or-nothing.
    expect(() => pickWorkspaceRepositories(dbRepos, yamlRepos, ['product', 'ghost'], true)).toThrow(
      /no repository named "ghost"/,
    );
  });

  it('falls back to yaml when settings has no repositories (legacy yaml-imported setup)', () => {
    const repos = pickWorkspaceRepositories([], yamlRepos, ['product'], true);
    expect(repos[0].url).toBe('git@github.com:legacy/product.git');
    // Empty list = all yaml repos.
    expect(pickWorkspaceRepositories([], yamlRepos, [], true).map((r) => r.name)).toEqual([
      'product',
    ]);
  });

  it('no settings repos and no yaml → clear diagnostic naming the missing source', () => {
    expect(() => pickWorkspaceRepositories([], [], ['product'], false)).toThrow(
      /no agents.yaml is loaded/,
    );
    expect(() => pickWorkspaceRepositories([], [], [], true)).toThrow(/does not define it either/);
  });
});

describe('resolveRepositoryNames (feature 019 — the repository set is the AGENT choice)', () => {
  it('behavior.repositories wins when non-empty (deprecated repository ignored)', () => {
    expect(resolveRepositoryNames({ repositories: ['infra'], repository: 'product' })).toEqual([
      'infra',
    ]);
    expect(resolveRepositoryNames({ repositories: ['infra', 'product'] })).toEqual([
      'infra',
      'product',
    ]);
  });

  it('deprecated behavior.repository is a one-element list', () => {
    expect(resolveRepositoryNames({ repository: 'infra' })).toEqual(['infra']);
    expect(
      pickWorkspaceRepositories(dbRepos, [], resolveRepositoryNames({ repository: 'infra' }), false).map(
        (r) => r.name,
      ),
    ).toEqual(['infra']);
  });

  it('absent/empty scope → [] → ALL workspace repositories (deliberate 019 behavior change)', () => {
    expect(resolveRepositoryNames({})).toEqual([]);
    expect(resolveRepositoryNames({ repositories: [] })).toEqual([]);
    expect(
      pickWorkspaceRepositories(dbRepos, [], resolveRepositoryNames({}), false).map((r) => r.name),
    ).toEqual(['product', 'infra']);
  });

  it('non-string junk degrades to the all-repos default, never crashes', () => {
    expect(resolveRepositoryNames({ repository: 42 })).toEqual([]);
    expect(resolveRepositoryNames({ repository: null })).toEqual([]);
    expect(resolveRepositoryNames({ repositories: 'infra' })).toEqual([]);
    expect(resolveRepositoryNames({ repositories: [42, null] })).toEqual([]);
    // Junk entries are dropped, valid ones survive.
    expect(resolveRepositoryNames({ repositories: ['infra', 42, ''] })).toEqual(['infra']);
  });
});

import { describe, it, expect } from 'vitest';
import { pickWorkspaceRepository } from './claude-cli.executor';

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

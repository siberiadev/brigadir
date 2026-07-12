import { describe, it, expect } from 'vitest';
import { getRepositories } from './workspace-settings';
import type { BrigadirDb } from './drizzle.constants';

/**
 * T121 — `getRepositories` accessor over the `workspaces.settings` blob. Uses a
 * minimal chainable stub for the drizzle `select().from().where().limit()` seam
 * (getWorkspaceSettings), so the test exercises the real accessor + zod parse
 * without a live database.
 */
function stubDb(settings: unknown): BrigadirDb {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([{ settings }]),
  };
  return { select: () => chain } as unknown as BrigadirDb;
}

describe('getRepositories (T121)', () => {
  it('returns the ordered repository list (first = default)', async () => {
    const db = stubDb({
      repositories: [
        { name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' },
        { name: 'web', git_url: 'git@github.com:acme/web.git', default_branch: 'develop' },
      ],
    });
    const repos = await getRepositories(db, 'ws-1');
    expect(repos.map((r) => r.name)).toEqual(['api', 'web']);
  });

  it('yields [] for an empty settings blob', async () => {
    expect(await getRepositories(stubDb({}), 'ws-1')).toEqual([]);
  });
});

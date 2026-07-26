import { describe, it, expect } from 'vitest';
import { getRepositories, getDependencyReleaseStatus } from './workspace-settings';
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

/**
 * Feature 032 — the dependency release threshold. `undefined` is the
 * load-bearing value: every caller then passes NO `releaseStatus` to the gate,
 * which is the byte-identical legacy path (FR-016).
 */
describe('getDependencyReleaseStatus (feature 032)', () => {
  it('returns the configured status name', async () => {
    expect(
      await getDependencyReleaseStatus(stubDb({ dependency_release_status: 'In Review' }), 'ws-1'),
    ).toBe('In Review');
  });

  it('returns undefined when the key is absent', async () => {
    expect(await getDependencyReleaseStatus(stubDb({}), 'ws-1')).toBeUndefined();
  });

  it('returns undefined for a null settings blob', async () => {
    expect(await getDependencyReleaseStatus(stubDb(null), 'ws-1')).toBeUndefined();
  });

  it('trims surrounding whitespace off a stored value', async () => {
    expect(
      await getDependencyReleaseStatus(stubDb({ dependency_release_status: '  In Review  ' }), 'ws-1'),
    ).toBe('In Review');
  });

  it('rejects a whitespace-only value at the schema boundary', async () => {
    // z.string().trim().min(1) — an empty-after-trim value is never a valid
    // setting; the dashboard PATCH deletes the key instead of storing one.
    await expect(
      getDependencyReleaseStatus(stubDb({ dependency_release_status: '   ' }), 'ws-1'),
    ).rejects.toThrow();
  });
});

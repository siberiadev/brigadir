import { describe, it, expect, vi } from 'vitest';
import { LazyJiraClient, type ResolvedClientSource } from './lazy-jira.client';
import type { JiraClient } from './jira-client.interface';

function fakeClient(tag: string): JiraClient {
  return {
    getBoard: vi.fn().mockResolvedValue({ type: 'kanban', projectKey: tag }),
  } as unknown as JiraClient;
}

describe('LazyJiraClient fingerprint memo (T137)', () => {
  it('builds once, reuses while the fingerprint is unchanged', async () => {
    const build = vi.fn(() => fakeClient('A'));
    const resolver = vi.fn(async (): Promise<ResolvedClientSource> => ({ fingerprint: 'fp-A', build }));
    const lazy = new LazyJiraClient(resolver);

    await lazy.getBoard(1);
    await lazy.getBoard(1);

    expect(resolver).toHaveBeenCalledTimes(2); // fingerprint re-checked each call
    expect(build).toHaveBeenCalledTimes(1); // but built only once
  });

  it('rebuilds with the new credentials when the fingerprint changes', async () => {
    let fingerprint = 'fp-A';
    const buildA = vi.fn(() => fakeClient('A'));
    const buildB = vi.fn(() => fakeClient('B'));
    const resolver = vi.fn(
      async (): Promise<ResolvedClientSource> => ({
        fingerprint,
        build: fingerprint === 'fp-A' ? buildA : buildB,
      }),
    );
    const lazy = new LazyJiraClient(resolver);

    const first = await lazy.getBoard(1);
    expect(first.projectKey).toBe('A');

    fingerprint = 'fp-B'; // rotation
    const second = await lazy.getBoard(1);
    expect(second.projectKey).toBe('B'); // rebuilt with the new creds

    expect(buildA).toHaveBeenCalledTimes(1);
    expect(buildB).toHaveBeenCalledTimes(1);
  });

  it('does not memoize a failed resolution (retries later)', async () => {
    const resolver = vi
      .fn<[], Promise<ResolvedClientSource>>()
      .mockRejectedValueOnce(new Error('no workspace yet'))
      .mockResolvedValue({ fingerprint: 'fp', build: () => fakeClient('ok') });
    const lazy = new LazyJiraClient(resolver);

    await expect(lazy.getBoard(1)).rejects.toThrow('no workspace yet');
    const ok = await lazy.getBoard(1);
    expect(ok.projectKey).toBe('ok');
  });
});

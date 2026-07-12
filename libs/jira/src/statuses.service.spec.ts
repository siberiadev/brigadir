import { describe, it, expect, vi } from 'vitest';
import type { BoardStatus } from '@brigadir/contracts';
import { StatusesService, StatusesUnavailable } from './statuses.service';
import type { BrigadirDb } from '@brigadir/database';
import type { JiraClient } from './jira-client.interface';
import type { JiraClientFactory } from './jira-client-factory';

const statuses: BoardStatus[] = [
  { id: '1', name: 'Ready for Dev', statusCategory: 'new' },
  { id: '2', name: 'Done', statusCategory: 'done' },
];

function fakeFactory(jira: JiraClient): JiraClientFactory {
  // Per-workspace client resolution is what the factory owns; here it always
  // yields the given fake client (the wrong-workspace regression is covered by
  // the integration suite with two seeded workspaces).
  return { forWorkspace: vi.fn().mockResolvedValue(jira) } as unknown as JiraClientFactory;
}

function fakeDb(projectKey: string | null): BrigadirDb {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(projectKey ? [{ projectKey }] : []),
  };
  return { select: () => chain } as unknown as BrigadirDb;
}

describe('StatusesService (T136)', () => {
  it('caches within the TTL — a second call makes no second Jira call', async () => {
    const jira = { getProjectStatuses: vi.fn().mockResolvedValue(statuses) } as unknown as JiraClient;
    const svc = new StatusesService(fakeDb('BRIG'), fakeFactory(jira));

    expect(await svc.get('ws-1')).toEqual(statuses);
    expect(await svc.get('ws-1')).toEqual(statuses);
    expect(jira.getProjectStatuses).toHaveBeenCalledTimes(1);
  });

  it('refresh:true forces a re-fetch', async () => {
    const jira = { getProjectStatuses: vi.fn().mockResolvedValue(statuses) } as unknown as JiraClient;
    const svc = new StatusesService(fakeDb('BRIG'), fakeFactory(jira));

    await svc.get('ws-1');
    await svc.get('ws-1', { refresh: true });
    expect(jira.getProjectStatuses).toHaveBeenCalledTimes(2);
  });

  it('an upstream failure surfaces as StatusesUnavailable', async () => {
    const jira = {
      getProjectStatuses: vi.fn().mockRejectedValue(new Error('502 upstream')),
    } as unknown as JiraClient;
    const svc = new StatusesService(fakeDb('BRIG'), fakeFactory(jira));

    await expect(svc.get('ws-1')).rejects.toBeInstanceOf(StatusesUnavailable);
  });
});

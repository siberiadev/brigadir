import { describe, it, expect, vi } from 'vitest';
import { TransitionDiscovery, type TransitionPort } from './transition-discovery';
import { JiraHttpError, NoTransitionPath } from './jira.errors';

function makePort(
  over: Partial<TransitionPort> & { currentStatus?: string } = {},
): TransitionPort & {
  getContext: ReturnType<typeof vi.fn>;
  listTransitions: ReturnType<typeof vi.fn>;
  postTransition: ReturnType<typeof vi.fn>;
} {
  const getContext = vi.fn(async () => ({
    projectKey: 'BRIG',
    issueType: 'Task',
    currentStatus: over.currentStatus ?? 'Ready for Dev',
  }));
  const listTransitions = vi.fn(async () => [
    { id: '11', to: { name: 'In Progress' } },
    { id: '21', to: { name: 'Code Review' } },
  ]);
  const postTransition = vi.fn(async () => undefined);
  return { getContext, listTransitions, postTransition, ...over } as never;
}

describe('TransitionDiscovery (T050)', () => {
  it('discovers, matches by name (case-insensitive), and posts the id', async () => {
    const port = makePort();
    const d = new TransitionDiscovery(port);
    await d.transitionTo('BRIG-1', 'code review');
    expect(port.postTransition).toHaveBeenCalledWith('BRIG-1', '21');
  });

  it('no-ops when the issue is already in the target status (FR-023)', async () => {
    const port = makePort({ currentStatus: 'Code Review' });
    const d = new TransitionDiscovery(port);
    await d.transitionTo('BRIG-1', 'Code Review');
    expect(port.listTransitions).not.toHaveBeenCalled();
    expect(port.postTransition).not.toHaveBeenCalled();
  });

  it('caches discovery per project|issuetype|fromStatus within TTL', async () => {
    const port = makePort();
    const d = new TransitionDiscovery(port, 60_000);
    await d.transitionTo('BRIG-1', 'Code Review');
    await d.transitionTo('BRIG-1', 'In Progress');
    expect(port.listTransitions).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('re-discovers after TTL expiry', async () => {
    const port = makePort();
    const d = new TransitionDiscovery(port, 0); // immediate expiry
    await d.transitionTo('BRIG-1', 'Code Review');
    await d.transitionTo('BRIG-1', 'Code Review');
    expect(port.listTransitions).toHaveBeenCalledTimes(2);
  });

  it('invalidates + re-discovers + retries once on 409', async () => {
    const port = makePort();
    port.postTransition
      .mockRejectedValueOnce(new JiraHttpError(409, 'POST', '/transitions', 'conflict'))
      .mockResolvedValueOnce(undefined);
    const d = new TransitionDiscovery(port);
    await d.transitionTo('BRIG-1', 'Code Review');
    expect(port.postTransition).toHaveBeenCalledTimes(2);
    expect(port.listTransitions).toHaveBeenCalledTimes(2); // re-discovered after invalidation
  });

  it('throws NoTransitionPath when no transition matches the target', async () => {
    const port = makePort();
    const d = new TransitionDiscovery(port);
    await expect(d.transitionTo('BRIG-1', 'Done')).rejects.toBeInstanceOf(NoTransitionPath);
  });
});

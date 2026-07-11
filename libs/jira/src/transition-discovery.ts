import type { JiraTransition } from '@brigadir/contracts';
import { JiraHttpError, NoTransitionPath } from './jira.errors';

/** Primitive Jira operations the discovery logic needs (testable without fetch). */
export interface TransitionPort {
  /** Current status + cache-key inputs for an issue. */
  getContext(issueKey: string): Promise<{ projectKey: string; issueType: string; currentStatus: string }>;
  listTransitions(issueKey: string): Promise<JiraTransition[]>;
  /** POST the transition; throws JiraHttpError(409) on a concurrent-move conflict. */
  postTransition(issueKey: string, transitionId: string): Promise<void>;
}

const eqCI = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Runtime transition discovery with cache + 409 retry (contracts.md C1 / research D5).
 *
 * `transitionTo(issueKey, target)`:
 *  - if the issue is already in `target` → no-op (FR-023 idempotency);
 *  - discover transitions (GET), match `to.name` case-insensitively, POST the id;
 *  - cache the discovered list per `project|issuetype|fromStatus` (TTL 10 min);
 *  - a 409 (state changed underneath) → invalidate + re-discover + retry once;
 *  - no matching transition → `NoTransitionPath` (a board-config fault, FR-008).
 */
export class TransitionDiscovery {
  private readonly cache = new Map<string, { transitions: JiraTransition[]; expiresAt: number }>();

  constructor(
    private readonly port: TransitionPort,
    private readonly ttlMs = 600_000,
  ) {}

  async transitionTo(issueKey: string, targetStatusName: string): Promise<void> {
    const ctx = await this.port.getContext(issueKey);
    if (eqCI(ctx.currentStatus, targetStatusName)) return; // already in target — satisfied

    const cacheKey = `${ctx.projectKey}|${ctx.issueType}|${ctx.currentStatus}`;
    let transitions = await this.load(cacheKey, issueKey, false);
    let match = transitions.find((t) => eqCI(t.to.name, targetStatusName));
    if (!match) throw new NoTransitionPath(issueKey, ctx.currentStatus, targetStatusName);

    try {
      await this.port.postTransition(issueKey, match.id);
    } catch (err) {
      if (err instanceof JiraHttpError && err.status === 409) {
        // Stale transition id — invalidate, re-discover, retry exactly once.
        this.cache.delete(cacheKey);
        transitions = await this.load(cacheKey, issueKey, true);
        match = transitions.find((t) => eqCI(t.to.name, targetStatusName));
        if (!match) throw new NoTransitionPath(issueKey, ctx.currentStatus, targetStatusName);
        await this.port.postTransition(issueKey, match.id);
        return;
      }
      throw err;
    }
  }

  private async load(
    cacheKey: string,
    issueKey: string,
    forceRefresh: boolean,
  ): Promise<JiraTransition[]> {
    if (!forceRefresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.transitions;
    }
    const transitions = await this.port.listTransitions(issueKey);
    this.cache.set(cacheKey, { transitions, expiresAt: Date.now() + this.ttlMs });
    return transitions;
  }
}

import { describe, it, expect, vi } from 'vitest';
import type { JiraClient } from '@brigadir/jira';
import type { RunTriggerService } from '@brigadir/runs';
import type { HumanTaskService } from '@brigadir/human-tasks';
import type { BrigadirDb } from '@brigadir/database';
import type { JiraIssue, StatusCategoryKey } from '@brigadir/contracts';
import {
  compareReleaseOrder,
  findCycleTickets,
  DependencyReleaseService,
  type ReleaseOrderKey,
  type ReleaseScope,
} from './dependency-release.service';

const k = (priorityId: number | null, jiraKey: string): ReleaseOrderKey => ({ priorityId, jiraKey });

describe('compareReleaseOrder (feature 022, FR-006)', () => {
  it('orders by priority id ascending (Highest=1 first)', () => {
    const sorted = [k(4, 'A-1'), k(1, 'A-2'), k(3, 'A-3')].sort(compareReleaseOrder);
    expect(sorted.map((x) => x.jiraKey)).toEqual(['A-2', 'A-3', 'A-1']);
  });

  it('NULLS LAST: un-prioritized tickets go after every prioritized one', () => {
    const sorted = [k(null, 'A-1'), k(5, 'A-2'), k(null, 'A-3'), k(1, 'A-4')].sort(compareReleaseOrder);
    expect(sorted.map((x) => x.jiraKey)).toEqual(['A-4', 'A-2', 'A-1', 'A-3']);
  });

  it('equal priority (and the all-null group) tiebreaks by jira_key lexicographically', () => {
    const sorted = [k(2, 'B-9'), k(2, 'B-10'), k(2, 'A-5')].sort(compareReleaseOrder);
    // Plain lexicographic — 'B-10' < 'B-9' is documented and acceptable (determinism, not aesthetics).
    expect(sorted.map((x) => x.jiraKey)).toEqual(['A-5', 'B-10', 'B-9']);
    const nulls = [k(null, 'C-2'), k(null, 'C-1')].sort(compareReleaseOrder);
    expect(nulls.map((x) => x.jiraKey)).toEqual(['C-1', 'C-2']);
  });

  it('is deterministic across repeated shuffles', () => {
    const items = [k(2, 'A-2'), k(null, 'A-9'), k(1, 'A-7'), k(2, 'A-1'), k(null, 'A-3')];
    const expected = ['A-7', 'A-1', 'A-2', 'A-3', 'A-9'];
    for (let i = 0; i < 10; i += 1) {
      const shuffled = [...items].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(shuffled.sort(compareReleaseOrder).map((x) => x.jiraKey)).toEqual(expected);
    }
  });
});

describe('findCycleTickets (feature 022, FR-009)', () => {
  const edges = (pairs: [string, string[]][]) => new Map(pairs);

  it('detects a 2-cycle', () => {
    expect(findCycleTickets(edges([['A', ['B']], ['B', ['A']]]))).toEqual(new Set(['A', 'B']));
  });

  it('detects a 3-cycle and leaves a chained-in outsider out', () => {
    const result = findCycleTickets(
      edges([
        ['A', ['B']],
        ['B', ['C']],
        ['C', ['A']],
        ['D', ['A']], // waits on the cycle but is not part of it
      ]),
    );
    expect(result).toEqual(new Set(['A', 'B', 'C']));
  });

  it('a plain chain has no cycle', () => {
    expect(findCycleTickets(edges([['A', ['B']], ['B', ['C']], ['C', []]]))).toEqual(new Set());
  });

  it('detects a self-link', () => {
    expect(findCycleTickets(edges([['A', ['A']]]))).toEqual(new Set(['A']));
  });

  it('ignores blockers outside the waiting set (they cannot close a cycle)', () => {
    expect(findCycleTickets(edges([['A', ['X']], ['B', ['A']]]))).toEqual(new Set());
  });
});

/**
 * Feature 032 (T009): the release pass reads `dependency_release_status` once
 * per pass and threads it into the gate. Stubbed at the drizzle/Jira seams —
 * the point under test is the WIRING (is the setting read, and does it reach
 * the gate?), not SQL; the end-to-end behaviour lives in
 * `test/integration/dependency-gate.spec.ts`.
 */

interface StubChain {
  from: () => StubChain;
  innerJoin: () => StubChain;
  where: () => StubChain;
  limit: () => Promise<unknown[]>;
  then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
}

function stubChain(rows: unknown[]): StubChain {
  const c: StubChain = {
    from: () => c,
    innerJoin: () => c,
    where: () => c,
    limit: () => Promise.resolve(rows),
    // The candidates query is awaited straight off `.where()` (no `.limit`).
    then: (resolve) => Promise.resolve(resolve(rows)),
  };
  return c;
}

const dependent = (blockerStatus: string, category: StatusCategoryKey): JiraIssue => ({
  key: 'DEP-1',
  id: '1',
  fields: {
    summary: 'dependent',
    status: { name: 'Ready for Dev', statusCategory: { key: 'new' } },
    updated: '2026-07-26T00:00:00.000Z',
    issuelinks: [
      {
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: {
          key: 'BLK-1',
          fields: { status: { name: blockerStatus, statusCategory: { key: category } } },
        },
      },
    ],
  },
});

function harness(settings: Record<string, unknown>, issue: JiraIssue) {
  const updates: Record<string, unknown>[] = [];
  const events: { runId?: string; payload?: Record<string, unknown> }[] = [];
  const db = {
    select: (cols?: Record<string, unknown>) => {
      const keys = Object.keys(cols ?? {});
      if (keys.length === 1 && keys[0] === 'settings') return stubChain([{ settings }]);
      // candidates()
      return stubChain([
        { ticketId: 't-1', ticketKey: 'DEP-1', agentId: 'a-1', agentKey: 'dev', behavior: {} },
      ]);
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({
      values: (row: { runId?: string; payload?: Record<string, unknown> }) => {
        events.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as BrigadirDb;

  const trigger = vi.fn().mockResolvedValue({ deduplicated: false, runId: 'run-new' });
  // Call 1 = the candidate re-fetch; any later call is one of classifyWaiting's
  // two blocker probes, which must see the BLOCKER (in scope, unresolved) —
  // otherwise the stub itself would classify it out_of_scope.
  const blocker: JiraIssue = {
    key: 'BLK-1',
    id: '2',
    fields: {
      summary: 'blocker',
      status: issue.fields.issuelinks![0].inwardIssue!.fields.status,
      updated: '2026-07-26T00:00:00.000Z',
    },
  };
  const searchUpdated = vi
    .fn()
    .mockImplementation(() => Promise.resolve(searchUpdated.mock.calls.length === 1 ? [issue] : [blocker]));
  const jira = {
    searchUpdated,
    getActiveSprintIds: vi.fn().mockResolvedValue([]),
  } as unknown as JiraClient;

  const service = new DependencyReleaseService(
    db,
    { trigger } as unknown as RunTriggerService,
    { createTicketBlocked: vi.fn() } as unknown as HumanTaskService,
  );
  const ws: ReleaseScope = { id: 'ws-1', projectKey: 'DEP', boardId: null, boardType: 'kanban' };
  return { service, ws, jira, trigger, updates, events, searchUpdated };
}

describe('DependencyReleaseService — configurable release status (feature 032, T009)', () => {
  it('releases a candidate whose blocker carries the configured status (not done)', async () => {
    const h = harness(
      { dependency_release_status: 'In Review' },
      dependent('In Review', 'indeterminate'),
    );
    await h.service.releaseFor(h.ws, h.jira);

    expect(h.trigger).toHaveBeenCalledTimes(1);
    // Released ⇒ blocked_state cleared, blocked_by KEPT as the observation.
    expect(h.updates.at(-1)).toMatchObject({ blockedState: null, blockedBy: ['BLK-1'] });
  });

  it('keeps the same candidate waiting when the setting is unset', async () => {
    const h = harness({}, dependent('In Review', 'indeterminate'));
    await h.service.releaseFor(h.ws, h.jira);

    expect(h.trigger).not.toHaveBeenCalled();
    // classifyWaiting persisted a waiting state instead of releasing.
    expect(h.updates.at(-1)).toMatchObject({ blockedState: 'waiting', blockedBy: ['BLK-1'] });
  });

  it('emits the early-release annotation on the new run (FR-015)', async () => {
    const h = harness(
      { dependency_release_status: 'In Review' },
      dependent('In Review', 'indeterminate'),
    );
    await h.service.releaseFor(h.ws, h.jira);

    const early = h.events.find((e) => e.payload?.source === 'dependency-release');
    expect(early).toBeDefined();
    expect(early?.runId).toBe('run-new');
    expect(early?.payload).toMatchObject({
      early: true,
      matched_status: 'In Review',
      blockers: [{ key: 'BLK-1', status: 'In Review' }],
    });
  });

  it('emits NO early-release annotation for a plain done-category release', async () => {
    const h = harness({ dependency_release_status: 'In Review' }, dependent('Done', 'done'));
    await h.service.releaseFor(h.ws, h.jira);

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.events.some((e) => e.payload?.source === 'dependency-release')).toBe(false);
  });

  it('does not classify a name-satisfied blocker as an open blocker', async () => {
    const h = harness(
      { dependency_release_status: 'In Review' },
      dependent('In Review', 'indeterminate'),
    );
    await h.service.releaseFor(h.ws, h.jira);
    // Nothing is waiting ⇒ classifyWaiting returns before its two probe
    // searches; only the candidate re-fetch happened.
    expect(h.searchUpdated).toHaveBeenCalledTimes(1);
  });
});

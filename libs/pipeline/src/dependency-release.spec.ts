import { describe, it, expect } from 'vitest';
import {
  compareReleaseOrder,
  findCycleTickets,
  type ReleaseOrderKey,
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

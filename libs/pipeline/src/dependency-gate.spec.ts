import { describe, it, expect } from 'vitest';
import type { JiraIssue, JiraIssueLink, StatusCategoryKey } from '@brigadir/contracts';
import {
  evaluateDependencyGate,
  blockingKeys,
  allBlockedByKeys,
  earlyReleaseBlockers,
} from './dependency-gate';

const blockedByLink = (
  blockerKey: string,
  category: StatusCategoryKey,
  statusName?: string,
): JiraIssueLink => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: {
    key: blockerKey,
    fields: {
      status: {
        name: statusName ?? (category === 'done' ? 'Done' : 'In Progress'),
        statusCategory: { key: category },
      },
    },
  },
});

const blocksLink = (blockedKey: string, category: StatusCategoryKey): JiraIssueLink => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  outwardIssue: {
    key: blockedKey,
    fields: { status: { name: 'In Progress', statusCategory: { key: category } } },
  },
});

const relatesLink = (otherKey: string): JiraIssueLink => ({
  type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
  inwardIssue: {
    key: otherKey,
    fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
  },
});

const issue = (links: JiraIssueLink[]): JiraIssue => ({
  key: 'BRIG-1',
  id: '10001',
  fields: {
    summary: 'x',
    status: { name: 'Ready for Dev', statusCategory: { key: 'new' } },
    updated: '2026-07-11T00:00:00.000Z',
    issuelinks: links,
  },
});

describe('evaluateDependencyGate (T053, D10)', () => {
  it('blocks when an inward "is blocked by" blocker is not done', () => {
    const i = issue([blockedByLink('BRIG-9', 'indeterminate')]);
    expect(evaluateDependencyGate(i)).toBe('blocked');
    expect(blockingKeys(i)).toEqual(['BRIG-9']);
  });

  it('clears when every blocker is done', () => {
    const i = issue([blockedByLink('BRIG-9', 'done'), blockedByLink('BRIG-8', 'done')]);
    expect(evaluateDependencyGate(i)).toBe('clear');
    expect(blockingKeys(i)).toEqual([]);
  });

  it('clears for a "relates to" link (never gates)', () => {
    expect(evaluateDependencyGate(issue([relatesLink('BRIG-7')]))).toBe('clear');
  });

  it('clears for an outward "blocks" link (this issue blocks another — never gates)', () => {
    expect(evaluateDependencyGate(issue([blocksLink('BRIG-6', 'indeterminate')]))).toBe('clear');
  });

  it('clears when there are no links', () => {
    expect(evaluateDependencyGate(issue([]))).toBe('clear');
  });

  it('blocks when at least one of several blockers is still open', () => {
    const i = issue([blockedByLink('BRIG-9', 'done'), blockedByLink('BRIG-8', 'new')]);
    expect(evaluateDependencyGate(i)).toBe('blocked');
    expect(blockingKeys(i)).toEqual(['BRIG-8']);
  });
});

/**
 * Feature 032 (contracts/dependency-release.md §1): the configurable release
 * threshold. Every row of the decision table, plus the FR-016 guarantee that an
 * absent option leaves the pre-032 behaviour untouched.
 */
describe('evaluateDependencyGate with dependency_release_status (feature 032)', () => {
  it('unset + blocker done ⇒ satisfied', () => {
    expect(evaluateDependencyGate(issue([blockedByLink('B-1', 'done')]))).toBe('clear');
  });

  it('unset + blocker not done ⇒ still blocked (legacy behaviour)', () => {
    expect(evaluateDependencyGate(issue([blockedByLink('B-1', 'indeterminate', 'In Review')]))).toBe(
      'blocked',
    );
  });

  it('configured + blocker carries that exact status (not done) ⇒ satisfied', () => {
    const i = issue([blockedByLink('B-1', 'indeterminate', 'In Review')]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'In Review' })).toBe('clear');
    expect(blockingKeys(i, { releaseStatus: 'In Review' })).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const i = issue([blockedByLink('B-1', 'indeterminate', 'IN REVIEW')]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'in review' })).toBe('clear');
  });

  it('matches after trimming both sides', () => {
    const i = issue([blockedByLink('B-1', 'indeterminate', ' In Review ')]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'In Review  ' })).toBe('clear');
  });

  it('configured + blocker in a different status ⇒ still blocked', () => {
    const i = issue([blockedByLink('B-1', 'indeterminate', 'In Progress')]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'In Review' })).toBe('blocked');
    expect(blockingKeys(i, { releaseStatus: 'In Review' })).toEqual(['B-1']);
  });

  it('keeps the OR-done guard: a done blocker satisfies even under a configured status', () => {
    const i = issue([blockedByLink('B-1', 'done', 'Released')]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'In Review' })).toBe('clear');
  });

  it('a configured status no blocker ever carries degrades to the done-category rule', () => {
    const open = issue([blockedByLink('B-1', 'indeterminate', 'In Progress')]);
    const done = issue([blockedByLink('B-1', 'done')]);
    expect(evaluateDependencyGate(open, { releaseStatus: 'Nonexistent' })).toBe('blocked');
    expect(evaluateDependencyGate(done, { releaseStatus: 'Nonexistent' })).toBe('clear');
  });

  it('blocks while ANY link is unsatisfied, even if another matched the status', () => {
    const i = issue([
      blockedByLink('B-1', 'indeterminate', 'In Review'),
      blockedByLink('B-2', 'indeterminate', 'In Progress'),
    ]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'In Review' })).toBe('blocked');
    expect(blockingKeys(i, { releaseStatus: 'In Review' })).toEqual(['B-2']);
  });

  it('never lets an outward "blocks" link be released by a status match', () => {
    const i = issue([blocksLink('B-1', 'indeterminate')]);
    expect(evaluateDependencyGate(i, { releaseStatus: 'In Progress' })).toBe('clear');
  });
});

describe('allBlockedByKeys (feature 032)', () => {
  it('returns every inward blocked-by key regardless of blocker status', () => {
    const i = issue([
      blockedByLink('B-1', 'done'),
      blockedByLink('B-2', 'indeterminate'),
      blockedByLink('B-3', 'new'),
    ]);
    expect(allBlockedByKeys(i)).toEqual(['B-1', 'B-2', 'B-3']);
  });

  it('ignores outward "blocks" and "relates to" links', () => {
    expect(allBlockedByKeys(issue([blocksLink('B-1', 'new'), relatesLink('B-2')]))).toEqual([]);
  });

  it('is empty when the issue has no links at all', () => {
    expect(allBlockedByKeys(issue([]))).toEqual([]);
  });
});

describe('earlyReleaseBlockers (feature 032, FR-015)', () => {
  it('names the blockers that cleared only via the configured status', () => {
    const i = issue([
      blockedByLink('B-1', 'indeterminate', 'In Review'),
      blockedByLink('B-2', 'done'),
    ]);
    expect(earlyReleaseBlockers(i, { releaseStatus: 'in review' })).toEqual([
      { key: 'B-1', status: 'In Review' },
    ]);
  });

  it('is empty for a plain done-category release', () => {
    const i = issue([blockedByLink('B-1', 'done')]);
    expect(earlyReleaseBlockers(i, { releaseStatus: 'In Review' })).toEqual([]);
  });

  it('is empty when no status is configured', () => {
    expect(earlyReleaseBlockers(issue([blockedByLink('B-1', 'indeterminate', 'In Review')]))).toEqual(
      [],
    );
  });
});

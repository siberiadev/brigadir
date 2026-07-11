import { describe, it, expect } from 'vitest';
import type { JiraIssue, JiraIssueLink, StatusCategoryKey } from '@brigadir/contracts';
import { evaluateDependencyGate, blockingKeys } from './dependency-gate';

const blockedByLink = (blockerKey: string, category: StatusCategoryKey): JiraIssueLink => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: {
    key: blockerKey,
    fields: { status: { name: category === 'done' ? 'Done' : 'In Progress', statusCategory: { key: category } } },
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

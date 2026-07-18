import { describe, it, expect } from 'vitest';
import type { JiraIssue } from '@brigadir/contracts';
import { parseJiraPriority } from './priority';

const issueWithPriority = (priority: JiraIssue['fields']['priority']): JiraIssue => ({
  key: 'BRIG-1',
  id: '10000',
  fields: {
    summary: 'x',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    updated: '2026-01-01T00:00:00.000Z',
    priority,
  },
});

describe('parseJiraPriority (feature 022)', () => {
  it('parses a built-in priority (numeric string id)', () => {
    expect(parseJiraPriority(issueWithPriority({ id: '2', name: 'High' }))).toEqual({
      priorityId: 2,
      priorityName: 'High',
    });
  });

  it('absent priority → both NULL', () => {
    expect(parseJiraPriority(issueWithPriority(undefined))).toEqual({
      priorityId: null,
      priorityName: null,
    });
    expect(parseJiraPriority(issueWithPriority(null))).toEqual({
      priorityId: null,
      priorityName: null,
    });
  });

  it('non-integer id → NULL id, name kept', () => {
    expect(parseJiraPriority(issueWithPriority({ id: 'P-high', name: 'Custom' }))).toEqual({
      priorityId: null,
      priorityName: 'Custom',
    });
  });

  it('empty name → NULL name', () => {
    expect(parseJiraPriority(issueWithPriority({ id: '3', name: '' }))).toEqual({
      priorityId: 3,
      priorityName: null,
    });
  });
});

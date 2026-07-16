import { describe, it, expect } from 'vitest';
import {
  ReportProgressSchema,
  RequestHumanSchema,
  CompleteTaskSchema,
  SearchTicketsSchema,
  GetTicketSchema,
  GetProjectOverviewSchema,
} from './callback-tools.schema';

describe('CallbackTools schemas', () => {
  it('report_progress accepts a valid payload and rejects a malformed one', () => {
    expect(
      ReportProgressSchema.safeParse({ stage: 'implementing', message: 'wrote service' })
        .success,
    ).toBe(true);
    expect(
      ReportProgressSchema.safeParse({ stage: 'x', message: 'y', percent: 150 }).success,
    ).toBe(false);
  });

  it('request_human accepts a valid payload and defaults blocking=true', () => {
    const res = RequestHumanSchema.safeParse({
      kind: 'blocker',
      title: 'Need repo access',
      details: 'The clone failed with 403.',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.blocking).toBe(true);
  });

  it('request_human rejects an unknown kind', () => {
    expect(
      RequestHumanSchema.safeParse({ kind: 'nope', title: 't', details: 'd' }).success,
    ).toBe(false);
  });

  // --- feature 013: suggested answer options ---

  it('request_human accepts up to 5 answer options and stays valid without them', () => {
    const base = { kind: 'question', title: 'Which strategy?', details: 'See ticket.' };
    expect(RequestHumanSchema.safeParse(base).success).toBe(true);
    expect(
      RequestHumanSchema.safeParse({
        ...base,
        options: [
          { label: 'Migrate config format', description: 'Breaking change' },
          { label: 'Keep backward compat', value: 'compat' },
        ],
      }).success,
    ).toBe(true);
  });

  it('request_human rejects out-of-bounds options (6 items / oversized label / extra key)', () => {
    const base = { kind: 'question', title: 't', details: 'd' };
    expect(
      RequestHumanSchema.safeParse({
        ...base,
        options: Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` })),
      }).success,
    ).toBe(false);
    expect(
      RequestHumanSchema.safeParse({ ...base, options: [{ label: 'x'.repeat(81) }] }).success,
    ).toBe(false);
    expect(
      RequestHumanSchema.safeParse({ ...base, options: [{ label: 'x', icon: 'y' }] }).success,
    ).toBe(false);
  });

  it('complete_task equals ReportSchema (accepts a valid report)', () => {
    expect(
      CompleteTaskSchema.safeParse({
        schema_version: 1,
        outcome: 'success',
        summary: 'done',
        checks: [],
      }).success,
    ).toBe(true);
  });

  // --- feature 011: read-only Jira tool inputs ---

  it('search_tickets accepts bounded structured filters and rejects raw JQL keys', () => {
    expect(SearchTicketsSchema.safeParse({}).success).toBe(true);
    expect(
      SearchTicketsSchema.safeParse({ text: 'login', status: 'In Progress', max_results: 50 }).success,
    ).toBe(true);
    expect(SearchTicketsSchema.safeParse({ jql: 'project = X' }).success).toBe(false);
    expect(SearchTicketsSchema.safeParse({ max_results: 51 }).success).toBe(false);
  });

  it('get_ticket requires a bounded key; get_project_overview takes no arguments', () => {
    expect(GetTicketSchema.safeParse({ key: 'BRIG-7' }).success).toBe(true);
    expect(GetTicketSchema.safeParse({}).success).toBe(false);
    expect(GetTicketSchema.safeParse({ key: 'x'.repeat(51) }).success).toBe(false);
    expect(GetProjectOverviewSchema.safeParse({}).success).toBe(true);
    expect(GetProjectOverviewSchema.safeParse({ jql: 'x' }).success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  GLOBAL_RUNS_DEFAULT_LIMIT,
  GlobalRunListItemSchema,
  GlobalRunsQuerySchema,
  GlobalRunsResponseSchema,
  HomeSummaryResponseSchema,
  HomeWorkspaceItemSchema,
  HomeWorkspacesResponseSchema,
} from './home.schema';

const validSummary = {
  running: 3,
  queued: 2,
  attention_24h: { failed: 1, timed_out: 1 },
  human_open: 3,
  spend: {
    '24h': { total_cost_usd: '18.4200', run_count: 37 },
    '7d': { total_cost_usd: '96.1000', run_count: 214 },
    '30d': { total_cost_usd: '342.7700', run_count: 861 },
  },
};

const validGlobalRunItem = {
  run_id: 'r-1',
  agent: { id: 'a-1', name: 'Hera', key: 'hera-reviewer', role: 'Reviewer' },
  ticket: { key: 'PAY-1', summary: 'Fix', jira_url: 'https://x.atlassian.net/browse/PAY-1' },
  workspace: { id: 'w-1', name: 'Payments' },
  status: 'running',
  attempt: 1,
  duration_ms: null,
  started_at: '2026-07-17T08:00:00.000Z',
  finished_at: null,
  cost_usd: null,
  created_at: '2026-07-17T07:59:58.000Z',
};

describe('HomeSummaryResponseSchema', () => {
  it('accepts a full summary (money as strings, all three periods)', () => {
    expect(HomeSummaryResponseSchema.safeParse(validSummary).success).toBe(true);
  });

  it('rejects a float total_cost_usd (money is a string on the wire)', () => {
    const res = HomeSummaryResponseSchema.safeParse({
      ...validSummary,
      spend: { ...validSummary.spend, '24h': { total_cost_usd: 18.42, run_count: 37 } },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['spend', '24h', 'total_cost_usd']);
    }
  });

  it('rejects a missing spend period (strict: all three always present)', () => {
    const { '30d': _omit, ...partial } = validSummary.spend;
    const res = HomeSummaryResponseSchema.safeParse({ ...validSummary, spend: partial });
    expect(res.success).toBe(false);
  });

  it('rejects unknown extra keys (strict envelope)', () => {
    const res = HomeSummaryResponseSchema.safeParse({ ...validSummary, extra: 1 });
    expect(res.success).toBe(false);
  });
});

describe('GlobalRunsQuerySchema', () => {
  it('parses a CSV status list, trimming whitespace', () => {
    const res = GlobalRunsQuerySchema.safeParse({ status: 'failed, timed_out' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.status).toEqual(['failed', 'timed_out']);
      expect(res.data.limit).toBe(GLOBAL_RUNS_DEFAULT_LIMIT);
      expect(res.data.finished_within).toBeUndefined();
    }
  });

  it('REQUIRES status — missing key fails', () => {
    const res = GlobalRunsQuerySchema.safeParse({});
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].path).toEqual(['status']);
  });

  it('rejects an empty status string (no unbounded listing)', () => {
    expect(GlobalRunsQuerySchema.safeParse({ status: '' }).success).toBe(false);
    expect(GlobalRunsQuerySchema.safeParse({ status: ' , ' }).success).toBe(false);
  });

  it('rejects an unknown status token', () => {
    const res = GlobalRunsQuerySchema.safeParse({ status: 'running,exploded' });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].path[0]).toBe('status');
  });

  it('accepts finished_within from the shared period enum only', () => {
    expect(
      GlobalRunsQuerySchema.safeParse({ status: 'failed', finished_within: '24h' }).success,
    ).toBe(true);
    expect(
      GlobalRunsQuerySchema.safeParse({ status: 'failed', finished_within: '48h' }).success,
    ).toBe(false);
  });

  it('coerces a numeric-string limit and falls back to the default on garbage/overflow', () => {
    const ok = GlobalRunsQuerySchema.safeParse({ status: 'running', limit: '25' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.limit).toBe(25);

    for (const bad of ['abc', '0', '-3', '9000']) {
      const res = GlobalRunsQuerySchema.safeParse({ status: 'running', limit: bad });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.limit).toBe(GLOBAL_RUNS_DEFAULT_LIMIT);
    }
  });
});

describe('GlobalRunsResponseSchema', () => {
  it('accepts items + full-count total ({items,total} — deliberately NOT paginated)', () => {
    const res = GlobalRunsResponseSchema.safeParse({ items: [validGlobalRunItem], total: 12 });
    expect(res.success).toBe(true);
  });

  it('rejects a pagination envelope (no page/page_size on dashboard lists)', () => {
    const res = GlobalRunsResponseSchema.safeParse({
      items: [],
      total: 0,
      page: 1,
      page_size: 10,
    });
    expect(res.success).toBe(false);
  });

  it('accepts a ticketless setup run (ticket null) and requires workspace', () => {
    expect(
      GlobalRunListItemSchema.safeParse({ ...validGlobalRunItem, ticket: null }).success,
    ).toBe(true);
    const { workspace: _omit, ...noWs } = validGlobalRunItem;
    expect(GlobalRunListItemSchema.safeParse(noWs).success).toBe(false);
  });
});

describe('HomeWorkspacesResponseSchema', () => {
  const validItem = {
    id: 'w-1',
    name: 'Payments',
    project_key: 'PAY',
    board_type: 'kanban',
    enabled: true,
    agent_count: 4,
    last_run: {
      run_id: 'r-1',
      status: 'running',
      started_at: '2026-07-17T08:00:00.000Z',
      finished_at: null,
      created_at: '2026-07-17T07:59:58.000Z',
    },
    attention_24h: 1,
  };

  it('accepts a full card item and a runless/paused variant', () => {
    expect(HomeWorkspaceItemSchema.safeParse(validItem).success).toBe(true);
    expect(
      HomeWorkspaceItemSchema.safeParse({
        ...validItem,
        enabled: false,
        last_run: null,
        attention_24h: 0,
        board_type: null,
      }).success,
    ).toBe(true);
  });

  it('response is a bare {items} — all workspaces, no pagination', () => {
    expect(HomeWorkspacesResponseSchema.safeParse({ items: [validItem] }).success).toBe(true);
    expect(
      HomeWorkspacesResponseSchema.safeParse({ items: [], total: 0 }).success,
    ).toBe(false);
  });

  it('rejects an unknown last_run status (reuses the run-status vocabulary)', () => {
    const res = HomeWorkspaceItemSchema.safeParse({
      ...validItem,
      last_run: { ...validItem.last_run, status: 'exploded' },
    });
    expect(res.success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { TicketHistoryResponseSchema, TicketHistoryRunSchema } from './ticket-history.schema';

const baseRun = {
  run_id: 'a3a7cc8e-0000-0000-0000-000000000001',
  agent: { id: 'agent-1', name: 'Vega', key: 'vega-developer', role: 'Developer', is_orchestrator: false },
  executor_type: 'mock',
  status: 'succeeded',
  outcome: 'success',
  attempt: 1,
  created_at: '2026-07-24T13:39:00.000Z',
  started_at: '2026-07-24T13:39:05.000Z',
  finished_at: '2026-07-24T13:56:00.000Z',
  duration_ms: 1015000,
  cost_usd: '1.2345',
  trigger: { source: 'poll', failing_run_id: null, deciding_run_id: null, target_agent: null },
  summary: 'Implemented the endpoint, PR #80.',
  routing: null,
  failed_checks: [],
  human_tasks: [],
};

const baseResponse = {
  ticket: {
    key: 'ST3-893',
    summary: 'Dashboard API: quality endpoint',
    jira_url: 'https://test.atlassian.net/browse/ST3-893',
    last_seen_status: 'Ready for Release',
    priority_name: 'Medium',
    blocked_state: null,
  },
  workspace: { id: 'ws-1', name: 'ST3 Design' },
  runs: [baseRun],
  aggregates: {
    runs_total: 1,
    rework_cycles: 0,
    total_cost_usd: '1.2345',
    first_run_at: '2026-07-24T13:39:00.000Z',
    last_finished_at: '2026-07-24T13:56:00.000Z',
  },
};

describe('TicketHistoryResponseSchema', () => {
  it('accepts a full happy-path response', () => {
    expect(TicketHistoryResponseSchema.safeParse(baseResponse).success).toBe(true);
  });

  it('accepts a triage run carrying routing + causal trigger refs', () => {
    const triage = {
      ...baseRun,
      run_id: 'a3a7cc8e-0000-0000-0000-000000000002',
      agent: { id: 'agent-2', name: 'Brigadir', key: 'brigadir', role: 'Teamlead', is_orchestrator: true },
      outcome: 'routed',
      trigger: {
        source: 'triage',
        failing_run_id: 'a3a7cc8e-0000-0000-0000-000000000001',
        deciding_run_id: null,
        target_agent: null,
      },
      routing: { target_agent: 'vega-developer', task: 'Fix the 3 QA defects on the same branch.' },
    };
    expect(TicketHistoryRunSchema.safeParse(triage).success).toBe(true);
  });

  it('accepts a failed run with fail-check chips and a human task', () => {
    const failed = {
      ...baseRun,
      status: 'failed',
      outcome: 'failure',
      failed_checks: [{ name: 'lint', reason: '3 unused imports' }, { name: 'e2e', reason: null }],
      human_tasks: [{ id: 'ht-1', kind: 'question', title: 'Which DB?', status: 'resolved' }],
    };
    expect(TicketHistoryRunSchema.safeParse(failed).success).toBe(true);
  });

  it('tolerates a report-less legacy run (null summary/routing/source)', () => {
    const legacy = {
      ...baseRun,
      outcome: null,
      summary: null,
      routing: null,
      trigger: { source: null, failing_run_id: null, deciding_run_id: null, target_agent: null },
      cost_usd: null,
      duration_ms: null,
      started_at: null,
      finished_at: null,
    };
    expect(TicketHistoryRunSchema.safeParse(legacy).success).toBe(true);
  });

  it('rejects unknown keys (strict envelope)', () => {
    expect(
      TicketHistoryResponseSchema.safeParse({ ...baseResponse, extra: true }).success,
    ).toBe(false);
    expect(TicketHistoryRunSchema.safeParse({ ...baseRun, report: {} }).success).toBe(false);
  });

  it('rejects a float cost (money is a string)', () => {
    expect(TicketHistoryRunSchema.safeParse({ ...baseRun, cost_usd: 1.23 }).success).toBe(false);
  });
});

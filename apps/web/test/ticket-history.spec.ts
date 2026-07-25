import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { TicketHistoryResponse, TicketHistoryRun } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import TicketHistory from '../src/views/TicketHistory.vue';

/**
 * Ticket-history page: header (key + Open Jira), flow strip, cycle grouping
 * (triage + rework collapsed under "Rework cycle N"), fail-reason chips, and
 * the not-found state.
 */

let seq = 0;
function run(overrides: Partial<TicketHistoryRun> & { run_id: string }): TicketHistoryRun {
  seq += 1;
  return {
    agent: { id: 'a1', name: 'Vega', key: 'vega-developer', role: 'Developer', is_orchestrator: false },
    executor_type: 'mock',
    status: 'succeeded',
    outcome: 'success',
    attempt: 1,
    created_at: `2026-07-24T13:1${seq % 10}:00.000Z`,
    started_at: null,
    finished_at: null,
    duration_ms: 60000,
    cost_usd: '0.5000',
    trigger: { source: 'poll', failing_run_id: null, deciding_run_id: null, target_agent: null },
    summary: null,
    routing: null,
    failed_checks: [],
    human_tasks: [],
    ...overrides,
  };
}

const sampleHistory: TicketHistoryResponse = {
  ticket: {
    key: 'BRIG-77',
    summary: 'Quality endpoint',
    jira_url: 'https://acme.atlassian.net/browse/BRIG-77',
    last_seen_status: 'Ready for Release',
    priority_name: 'Medium',
    blocked_state: null,
  },
  workspace: { id: 'ws-1', name: 'Acme' },
  runs: [
    run({ run_id: 'dev', summary: 'Implemented, PR #1.' }),
    run({
      run_id: 'qa1',
      status: 'failed',
      outcome: 'failure',
      failed_checks: [{ name: 'lint', reason: '3 unused imports' }],
    }),
    run({
      run_id: 'triage1',
      agent: { id: 'a9', name: 'Brigadir', key: 'brigadir', role: 'Teamlead', is_orchestrator: true },
      outcome: 'routed',
      trigger: { source: 'triage', failing_run_id: 'qa1', deciding_run_id: null, target_agent: null },
      routing: { target_agent: 'vega-developer', task: 'Fix the lint errors.' },
      summary: 'Routing back to the developer.',
    }),
    run({
      run_id: 'rework1',
      trigger: { source: 'rework', failing_run_id: 'qa1', deciding_run_id: 'triage1', target_agent: 'vega-developer' },
      human_tasks: [{ id: 'ht-1', kind: 'question', title: 'Which formatter?', status: 'resolved' }],
    }),
    run({ run_id: 'qa2', summary: 'All green.' }),
  ],
  aggregates: {
    runs_total: 5,
    rework_cycles: 1,
    total_cost_usd: '2.5000',
    first_run_at: '2026-07-24T13:11:00.000Z',
    last_finished_at: '2026-07-24T13:45:00.000Z',
  },
};

function mountPage() {
  server.use(
    http.get('/api/workspaces/ws-1/tickets/BRIG-77/history', () => HttpResponse.json(sampleHistory)),
  );
  return mountWithProviders(TicketHistory, { props: { id: 'ws-1', ticketKey: 'BRIG-77' } });
}

describe('TicketHistory — header + flow + cycles', () => {
  it('renders the header with the key, aggregates, and an Open Jira button', async () => {
    const wrapper = mountPage();
    await flush();

    expect(wrapper.find('[data-test="th-ticket-key"]').text()).toContain('BRIG-77');
    expect(wrapper.find('[data-test="th-ticket-key"]').text()).toContain('Quality endpoint');
    expect(wrapper.find('[data-test="th-jira-status"]').text()).toBe('Ready for Release');
    expect(wrapper.find('[data-test="th-aggregates"]').text()).toContain('5 runs');
    expect(wrapper.find('[data-test="th-aggregates"]').text()).toContain('1 rework cycle');

    const jira = wrapper.find('[data-test="open-jira"]');
    expect(jira.attributes('href')).toBe('https://acme.atlassian.net/browse/BRIG-77');
    expect(jira.attributes('target')).toBe('_blank');
    expect(jira.text()).toContain('Open Jira');
  });

  it('has no flow strip; shows agent roles next to names in the timeline', async () => {
    const wrapper = mountPage();
    await flush();

    expect(wrapper.find('[data-test="flow-strip"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="role-dev"]').text()).toBe('Developer');
    expect(wrapper.find('[data-test="role-triage1"]').text()).toBe('Teamlead');
  });

  it('hides the run summary behind a per-card Show more toggle', async () => {
    const wrapper = mountPage();
    await flush();

    // Collapsed by default — the summary text is not in the DOM.
    expect(wrapper.find('[data-test="summary-dev"]').exists()).toBe(false);
    const toggle = wrapper.find('[data-test="toggle-summary-dev"]');
    expect(toggle.text()).toBe('Show more');

    await toggle.trigger('click');
    expect(wrapper.find('[data-test="summary-dev"]').text()).toContain('Implemented, PR #1.');
    expect(wrapper.find('[data-test="toggle-summary-dev"]').text()).toBe('Show less');

    // A run without a summary renders no toggle.
    expect(wrapper.find('[data-test="toggle-summary-qa1"]').exists()).toBe(false);
  });

  it('groups triage + rework under a cycle block; main-pass runs stay flat', async () => {
    const wrapper = mountPage();
    await flush();

    const cycle = wrapper.find('[data-test="cycle-1"]');
    expect(cycle.exists()).toBe(true);
    expect(cycle.text()).toContain('Rework cycle 1');
    // Both the triage and its rework live INSIDE the cycle block.
    expect(cycle.find('[data-test="run-block-triage1"]').exists()).toBe(true);
    expect(cycle.find('[data-test="run-block-rework1"]').exists()).toBe(true);
    expect(cycle.find('[data-test="routed-to-triage1"]').text()).toContain('vega-developer');
    // Main-pass runs are NOT inside a cycle.
    expect(wrapper.find('[data-test="run-block-dev"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="cycle-2"]').exists()).toBe(false);
  });

  it('shows fail-reason chips on the failed run and human-task chips on the rework', async () => {
    const wrapper = mountPage();
    await flush();

    const chips = wrapper.find('[data-test="failed-checks-qa1"]');
    expect(chips.exists()).toBe(true);
    expect(chips.text()).toContain('lint');
    expect(wrapper.find('[data-test="run-block-rework1"]').text()).toContain('question: Which formatter?');
  });

  it('renders the not-found empty state on a 404', async () => {
    server.use(
      http.get('/api/workspaces/ws-1/tickets/GONE-1/history', () =>
        HttpResponse.json(
          { error: { code: 'ticket_not_found', message: 'Ticket not found in this workspace.' } },
          { status: 404 },
        ),
      ),
    );
    const wrapper = mountWithProviders(TicketHistory, { props: { id: 'ws-1', ticketKey: 'GONE-1' } });
    await flush();

    expect(wrapper.find('[data-test="ticket-not-found"]').exists()).toBe(true);
  });
});

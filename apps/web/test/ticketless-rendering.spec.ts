import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import {
  paginated,
  sampleHumanQueueOpen,
  sampleRunCard,
  sampleRunListItem,
} from './handlers';
import Runs from '../src/views/Runs.vue';
import RunCard from '../src/views/RunCard.vue';
import HumanQueue from '../src/views/HumanQueue.vue';

/**
 * Feature 011 US4 (FR-007, SC-006): ticketless workspace-setup entries render
 * with the "Workspace setup" label — no Jira link, no broken cells — in the
 * runs table, the run card, and the Human Queue (row + drawer); the resume
 * agent picker is hidden for ticketless tasks.
 */

const setupRun = { ...sampleRunListItem, run_id: 'run-setup', ticket: null, status: 'running' as const };

const setupTask = {
  id: 'ht-setup',
  kind: 'question' as const,
  title: 'Which repositories should the team cover?',
  details: null,
  blocking: true,
  ticket: null,
  agent: { id: 'ag-orch', name: 'brigadir' },
  workspace: { id: 'ws-1', name: 'Acme' },
  run_id: 'run-setup',
  created_at: '2026-07-16T09:00:00.000Z',
};

describe('ticketless rendering (feature 011, US4)', () => {
  it('runs table: null ticket renders the label instead of a link', async () => {
    server.use(
      http.get('/api/workspaces/:id/runs', () => HttpResponse.json(paginated([setupRun]))),
    );
    const wrapper = mountWithProviders(Runs, { props: { id: 'ws-1' } });
    await flush();

    const label = wrapper.find('[data-test="setup-label"]');
    expect(label.exists()).toBe(true);
    expect(label.text()).toBe('Workspace setup');
    // No dead anchor in the ticket column for the setup row.
    expect(wrapper.html()).not.toContain('href="null"');
  });

  it('run card: null ticket renders the label header, no Jira link', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({ ...sampleRunCard, ticket: null }),
      ),
    );
    const wrapper = mountWithProviders(RunCard, { props: { id: 'run-setup' } });
    await flush();

    const header = wrapper.find('[data-test="ticket-key"]');
    expect(header.text()).toContain('Workspace setup');
    expect(header.find('a').exists()).toBe(false);
  });

  it('human queue: ticketless task renders label in row and drawer; picker hidden', async () => {
    server.use(
      http.get('/api/human-tasks', () =>
        HttpResponse.json({ ...sampleHumanQueueOpen, total: 1, items: [setupTask] }),
      ),
    );
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    expect(wrapper.find('[data-test="task-setup-label"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="task-ticket"]').exists()).toBe(false);

    // Open the drawer (same idiom as human-queue.spec.ts).
    await wrapper.find('[data-test="task-ht-setup"]').trigger('click');
    await flush();
    expect(wrapper.find('[data-test="drawer-header"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="drawer-setup-label"]').text()).toBe('Workspace setup');
    expect(wrapper.find('[data-test="drawer-ticket"]').exists()).toBe(false);
    // The resume picker never renders for a ticketless task (D12) even though
    // the task is blocking and the default action is resume.
    expect(wrapper.findComponent({ name: 'ResumeAgentPicker' }).exists()).toBe(false);
  });
});

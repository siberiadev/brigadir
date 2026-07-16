import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleAgent, sampleRunList, sampleRunListItem } from './handlers';
import AgentsList from '../src/views/AgentsList.vue';

/**
 * Feature 011 (D11, AC US1-2): the "Generate agents" action on the Agents tab.
 * Offered only while the roster is orchestrator-only; an active workspace-setup
 * run replaces the button with a progress link; a worker agent hides it.
 */

const orchestratorOnly = paginated([
  { ...sampleAgent, id: 'ag-orch', name: 'brigadir', is_orchestrator: true },
]);

const noSetupRuns = { items: [], page: 1, page_size: 10, total: 0 };

function useAgents(list: unknown) {
  server.use(
    http.get('/api/agents', () =>
      HttpResponse.json(list as Parameters<typeof HttpResponse.json>[0]),
    ),
  );
}

function useSetupRuns(list: unknown) {
  server.use(
    http.get('/api/workspaces/:id/runs', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('source') === 'workspace-setup') {
        return HttpResponse.json(list as Parameters<typeof HttpResponse.json>[0]);
      }
      return HttpResponse.json(sampleRunList);
    }),
  );
}

describe('AgentsList — Generate agents (feature 011)', () => {
  it('offers the button on an orchestrator-only roster and POSTs generate-agents', async () => {
    useAgents(orchestratorOnly);
    useSetupRuns(noSetupRuns);
    let posted = false;
    server.use(
      http.post('/api/workspaces/:id/generate-agents', () => {
        posted = true;
        return HttpResponse.json({ run_id: 'run-setup-1' }, { status: 202 });
      }),
    );

    const wrapper = mountWithProviders(AgentsList, { props: { id: 'ws-1' } });
    await flush();

    const btn = wrapper.find('[data-test="generate-agents"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flush();
    expect(posted).toBe(true);
  });

  it('replaces the button with a progress link while a setup run is active', async () => {
    useAgents(orchestratorOnly);
    useSetupRuns({
      items: [{ ...sampleRunListItem, run_id: 'run-setup-2', ticket: null, status: 'running' }],
      page: 1,
      page_size: 10,
      total: 1,
    });

    const wrapper = mountWithProviders(AgentsList, { props: { id: 'ws-1' } });
    await flush();

    expect(wrapper.find('[data-test="generate-agents"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="generate-agents-progress"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="setup-run-link"]').exists()).toBe(true);
  });

  it('hides the action entirely once a worker agent exists', async () => {
    // Default handler roster contains the (non-orchestrator) sampleAgent.
    useSetupRuns(noSetupRuns);
    const wrapper = mountWithProviders(AgentsList, { props: { id: 'ws-1' } });
    await flush();

    expect(wrapper.find('[data-test="generate-agents"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="generate-agents-progress"]').exists()).toBe(false);
  });
});

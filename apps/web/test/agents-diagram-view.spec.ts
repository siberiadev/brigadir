import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { defineComponent, h } from 'vue';
import type { VueWrapper } from '@vue/test-utils';
import type { AgentResponse } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleAgent, sampleAgentWithRole } from './handlers';
import AgentsList from '../src/views/AgentsList.vue';
import AgentForm from '../src/components/AgentForm/AgentForm.vue';

/**
 * Feature 018 — Diagram view mode interactions. The real Vue Flow canvas cannot
 * measure itself under jsdom, so <VueFlow> is replaced by a stub that renders
 * each node through the same named slots (#node-status / #node-agent) the real
 * component uses — the node SFCs, their events, and the AgentsList wiring run
 * for real; only the SVG canvas is faked (research R3). Graph SEMANTICS are
 * asserted in agents-diagram-graph.spec.ts, not here.
 */

type SlotProps = { id: string; data: unknown };

const VueFlowStub = defineComponent({
  name: 'VueFlow',
  props: { nodes: { type: Array, default: () => [] }, edges: { type: Array, default: () => [] } },
  setup(props, { slots }) {
    return () =>
      h(
        'div',
        { 'data-test': 'vueflow-stub' },
        (props.nodes as Array<{ id: string; type: string; data: unknown }>).map((n) =>
          h(
            'div',
            { key: n.id, 'data-node-id': n.id },
            slots[`node-${n.type}`]?.({ id: n.id, data: n.data } satisfies SlotProps),
          ),
        ),
      );
  },
});

const stubs = { VueFlow: VueFlowStub, Handle: true };

let active: VueWrapper | undefined;

afterEach(() => {
  active?.unmount();
  active = undefined;
  // FormDialog teleports to <body>; scrub lingering overlays between tests.
  document.body.querySelectorAll('.el-overlay, .el-dialog__wrapper').forEach((n) => n.remove());
});

/** The orchestrator — must never appear on the canvas. */
const orchestrator: AgentResponse = {
  ...sampleAgent,
  id: 'ag-orch',
  name: 'Brigadir',
  key: 'brigadir',
  is_orchestrator: true,
};

function serveRoster(roster: () => AgentResponse[]) {
  const hits = { agents: 0, statuses: 0 };
  server.use(
    http.get('/api/agents', () => {
      hits.agents += 1;
      return HttpResponse.json(paginated(roster()));
    }),
    http.get('/api/workspaces/:id/statuses', () => {
      hits.statuses += 1;
      return HttpResponse.json({
        statuses: [
          { id: '10001', name: 'Ready for Dev', statusCategory: 'new' },
          { id: '3', name: 'In Progress', statusCategory: 'indeterminate' },
          { id: '10002', name: 'In Review', statusCategory: 'indeterminate' },
          { id: '10003', name: 'Blocked', statusCategory: 'new' },
          { id: '10004', name: 'Done', statusCategory: 'done' },
        ],
      });
    }),
  );
  return hits;
}

async function mountAgentsPage(roster: () => AgentResponse[] = () => [sampleAgent, orchestrator]) {
  const hits = serveRoster(roster);
  const wrapper = mountWithProviders(AgentsList, { props: { id: 'ws-1' }, global: { stubs } });
  active = wrapper;
  await flush();
  return { wrapper, hits };
}

// The segmented control's radios carry no value attribute (EP binds values
// internally) — options are [List, Diagram], so index selects the mode.
async function setMode(wrapper: VueWrapper, index: 0 | 1) {
  const radios = wrapper.findAll('[data-test="view-mode-toggle"] input[type="radio"]');
  expect(radios.length).toBe(2);
  await radios[index].setValue();
  await flush();
}

const toDiagram = (wrapper: VueWrapper) => setMode(wrapper, 1);

describe('AgentsList — view mode toggle (US1)', () => {
  it('defaults to List on every mount: table shown, no diagram, toggle present (FR-001/002)', async () => {
    const { wrapper } = await mountAgentsPage();

    expect(wrapper.find('[data-test="view-mode-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agents-diagram"]').exists()).toBe(false);
  });

  it('switches to Diagram and back without any additional /api/agents or /statuses requests (FR-003, SC-005)', async () => {
    const { wrapper, hits } = await mountAgentsPage();
    const afterMount = { ...hits };

    await toDiagram(wrapper);
    expect(wrapper.find('[data-test="agents-diagram"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(false);

    await setMode(wrapper, 0);
    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agents-diagram"]').exists()).toBe(false);

    // The toggle itself fetched nothing.
    expect(hits.agents).toBe(afterMount.agents);
    expect(hits.statuses).toBe(afterMount.statuses);
  });

  it('renders agent and status nodes on the canvas; the orchestrator never appears (US1)', async () => {
    const { wrapper } = await mountAgentsPage(() => [sampleAgent, sampleAgentWithRole, orchestrator]);
    await toDiagram(wrapper);

    const agentNodes = wrapper.findAll('[data-test="diagram-agent-node"]');
    expect(agentNodes).toHaveLength(2);
    expect(wrapper.find('[data-test="agents-diagram"]').text()).not.toContain('Brigadir');
    expect(wrapper.findAll('[data-test="diagram-status-node"]').length).toBeGreaterThanOrEqual(5);
  });

  it('shows the JQL badge with the raw JQL as tooltip content (FR-008)', async () => {
    const jqlAgent: AgentResponse = { ...sampleAgent, id: 'ag-jql', key: 'jql-agent', trigger_status: null, trigger_jql: 'labels = hotfix' };
    const { wrapper } = await mountAgentsPage(() => [jqlAgent]);
    await toDiagram(wrapper);

    const badge = wrapper.find('[data-test="agent-jql-badge"]');
    expect(badge.exists()).toBe(true);
    const tooltip = wrapper
      .findAllComponents({ name: 'ElTooltip' })
      .find((t) => t.find('[data-test="agent-jql-badge"]').exists());
    expect(tooltip?.props('content')).toBe('labels = hotfix');
  });

  it('statuses query error → explicit error state, no partial graph (FR-018, US1-12)', async () => {
    server.use(
      http.get('/api/workspaces/:id/statuses', () =>
        HttpResponse.json(
          { error: { code: 'statuses_unavailable', message: 'Jira down' } },
          { status: 502 },
        ),
      ),
    );
    const wrapper = mountWithProviders(AgentsList, { props: { id: 'ws-1' }, global: { stubs } });
    active = wrapper;
    await flush();
    await toDiagram(wrapper);

    expect(wrapper.find('[data-test="diagram-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="diagram-agent-node"]').exists()).toBe(false);
  });

  it('no visible worker agents → empty-state hint plus muted status nodes (FR-018)', async () => {
    const { wrapper } = await mountAgentsPage(() => [orchestrator]);
    await toDiagram(wrapper);

    expect(wrapper.find('[data-test="diagram-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="diagram-agent-node"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="diagram-status-node"]')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// US2 — create an agent from a status node ("+" → AgentForm with pre-filled
// trigger). The dialog teleports to <body>; its FORM is asserted through the
// component tree (findComponent works across teleports), its buttons through
// document.body.
// ---------------------------------------------------------------------------

function triggerSelectValue(wrapper: VueWrapper): unknown {
  const form = wrapper.findComponent(AgentForm);
  expect(form.exists()).toBe(true);
  const select = form
    .findAllComponents({ name: 'ElSelect' })
    .find((s) => s.attributes('data-test') === 'trigger-status-select');
  return select?.props('modelValue');
}

async function clickPlusOn(wrapper: VueWrapper, statusName: string) {
  const btn = wrapper.find(`[data-node-id="status:${statusName}"] [data-test="status-add-agent"]`);
  expect(btn.exists()).toBe(true);
  await btn.trigger('click');
  await flush();
}

const bodyClick = async (sel: string) => {
  (document.querySelector(`[data-test="${sel}"]`) as HTMLElement).click();
  await flush();
};

describe('AgentsList — create agent from a status node (US2)', () => {
  it('"+" opens the existing create dialog with trigger_status pre-filled to that status (FR-015)', async () => {
    const { wrapper } = await mountAgentsPage();
    await toDiagram(wrapper);

    await clickPlusOn(wrapper, 'Done');
    expect(triggerSelectValue(wrapper)).toBe('Done');
  });

  it('consecutive "+" clicks on different statuses each re-seed the form (remount-key guard)', async () => {
    const { wrapper } = await mountAgentsPage();
    await toDiagram(wrapper);

    await clickPlusOn(wrapper, 'Done');
    expect(triggerSelectValue(wrapper)).toBe('Done');
    await bodyClick('cancel-button');

    await clickPlusOn(wrapper, 'Blocked');
    expect(triggerSelectValue(wrapper)).toBe('Blocked');
  });

  it('a successful save closes the dialog and the diagram re-derives with the new agent (FR-017, US2-3)', async () => {
    const created: AgentResponse = {
      ...sampleAgent,
      id: 'ag-new',
      name: 'Deployer',
      key: 'deployer',
      trigger_status: 'Done',
      status_success: 'Done',
      status_failure: 'Blocked',
    };
    let roster = [sampleAgent];
    const { wrapper } = await mountAgentsPage(() => roster);
    server.use(
      http.post('/api/agents', () => {
        roster = [...roster, created];
        return HttpResponse.json({ ...created, warnings: [] }, { status: 201 });
      }),
    );
    await toDiagram(wrapper);
    expect(wrapper.findAll('[data-test="diagram-agent-node"]')).toHaveLength(1);

    await clickPlusOn(wrapper, 'Done');
    const form = wrapper.findComponent(AgentForm);
    (document.querySelector('[data-test="name-input"]') as HTMLInputElement).value = 'Deployer';
    document.querySelector('[data-test="name-input"]')!.dispatchEvent(new Event('input'));
    await flush();
    await (form.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    // Dialog closed, diagram re-derived via the shared query invalidation.
    expect(wrapper.findComponent(AgentForm).exists()).toBe(false);
    expect(wrapper.findAll('[data-test="diagram-agent-node"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="agents-diagram"]').text()).toContain('Deployer');
  });

  it('cancel leaves the diagram unchanged (US2-5)', async () => {
    const { wrapper } = await mountAgentsPage();
    await toDiagram(wrapper);
    const before = wrapper.findAll('[data-test="diagram-agent-node"]').length;

    await clickPlusOn(wrapper, 'Done');
    await bodyClick('cancel-button');

    expect(wrapper.findComponent(AgentForm).exists()).toBe(false);
    expect(wrapper.findAll('[data-test="diagram-agent-node"]')).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// US3 — edit an agent from its node (same dialog and behavior as the table's
// Edit action; a disabling edit removes the node and mutes its statuses).
// ---------------------------------------------------------------------------

describe('AgentsList — edit agent from its node (US3)', () => {
  it('the edit button opens the existing edit dialog for exactly that agent (FR-016)', async () => {
    const { wrapper } = await mountAgentsPage(() => [sampleAgent, sampleAgentWithRole]);
    await toDiagram(wrapper);

    const btn = wrapper.find(
      `[data-node-id="agent:${sampleAgentWithRole.id}"] [data-test="agent-edit"]`,
    );
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flush();

    const form = wrapper.findComponent(AgentForm);
    expect(form.exists()).toBe(true);
    expect((form.props() as { agent: AgentResponse | null }).agent?.id).toBe(
      sampleAgentWithRole.id,
    );
    // Edit mode marker: the read-only key field is present.
    expect(document.querySelector('[data-test="key-readonly"]')).not.toBeNull();
  });

  it('a disabling edit removes the node and its edges; solely-referenced statuses turn muted (US3-3)', async () => {
    let roster = [sampleAgent];
    const { wrapper } = await mountAgentsPage(() => roster);
    server.use(
      http.put('/api/agents/:id', () => {
        roster = [{ ...sampleAgent, enabled: false }];
        return HttpResponse.json({ ...sampleAgent, enabled: false, warnings: [] });
      }),
    );
    await toDiagram(wrapper);
    expect(wrapper.findAll('[data-test="diagram-agent-node"]')).toHaveLength(1);

    await wrapper
      .find(`[data-node-id="agent:${sampleAgent.id}"] [data-test="agent-edit"]`)
      .trigger('click');
    await flush();
    const form = wrapper.findComponent(AgentForm);
    await (form.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(wrapper.findComponent(AgentForm).exists()).toBe(false);
    expect(wrapper.find('[data-test="diagram-agent-node"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="diagram-empty"]').exists()).toBe(true);
  });
});

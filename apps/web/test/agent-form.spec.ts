import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleStatuses, sampleAgent, sampleExecutors, sampleDisabledExecutor } from './handlers';
import AgentForm from '../src/components/AgentForm/AgentForm.vue';

/**
 * T154 — Agent form (US2). Status selects come from the faked flat `/statuses`,
 * the client linter mirror (the same @brigadir/contracts function the server
 * enforces) attaches issues per field, and the cycle warning is non-blocking.
 */

const statusNames = sampleStatuses.statuses.map((s) => s.name);

function mountForm(agent: typeof sampleAgent | null = null) {
  return mountWithProviders(AgentForm, {
    props: { workspaceId: 'ws-1', agent, repositories: [] },
  });
}

function selectByTest(wrapper: VueWrapper, test: string) {
  const el = wrapper
    .findAllComponents({ name: 'ElSelect' })
    .find((s) => s.attributes('data-test') === test);
  if (!el) throw new Error(`no ElSelect with data-test=${test}`);
  return el;
}

async function setStatus(wrapper: VueWrapper, test: string, value: string) {
  await selectByTest(wrapper, test).setValue(value);
  await flush();
}

describe('AgentForm — statuses + linter mirror', () => {
  it('populates every status select from the flat /statuses set, no columns (US2 #1)', async () => {
    const wrapper = mountForm();
    await flush();

    // No grouped/columnar options — a plain flat list.
    expect(wrapper.findAllComponents({ name: 'ElOptionGroup' }).length).toBe(0);

    const successOptions = selectByTest(wrapper, 'status-success-select')
      .findAllComponents({ name: 'ElOption' })
      .map((o) => o.props('value'));
    expect(successOptions).toEqual(statusNames);
  });

  it('flags a status_success absent from the board immediately, and a 422 keeps it pinned (US2 #2/#9)', async () => {
    server.use(
      http.post('/api/agents', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_failed',
              message: 'Agent could not be saved.',
              issues: [
                {
                  path: ['status_success'],
                  code: 'status_absent',
                  message: '"Done Done" is not a status on this board.',
                  value: 'Done Done',
                  level: 'error',
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );

    const wrapper = mountForm();
    await flush();
    await setStatus(wrapper, 'status-success-select', 'Done Done');

    // Client mirror flags it immediately.
    expect(wrapper.find('[data-test="status-success-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="status-success-error"]').text()).toContain('Done Done');

    // Submitting → server 422 keeps it pinned.
    await wrapper.find('[data-test="name-input"]').setValue('Impl');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(wrapper.find('[data-test="status-success-error"]').exists()).toBe(true);
  });

  it('flags a duplicate trigger among enabled agents, cleared by a distinct trigger_jql (US2 #3/#4)', async () => {
    const wrapper = mountForm();
    await flush();

    // sampleAgent (enabled) already triggers on "Ready for Dev" with no JQL.
    await setStatus(wrapper, 'trigger-status-select', 'Ready for Dev');
    expect(wrapper.find('[data-test="trigger-status-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="trigger-status-error"]').text()).toContain('already triggers');

    // A distinct trigger_jql disambiguates → mirror clears, save is allowed.
    await wrapper.find('[data-test="trigger-jql-input"]').setValue('labels = special');
    await flush();
    expect(wrapper.find('[data-test="trigger-status-error"]').exists()).toBe(false);

    let saved = false;
    server.use(http.post('/api/agents', () => { saved = true; return HttpResponse.json(sampleAgent, { status: 201 }); }));
    await wrapper.find('[data-test="name-input"]').setValue('Impl2');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(saved).toBe(true);
  });

  it('preview button is gated on a trigger_status, then posts {status} and renders the count', async () => {
    let sentStatus: string | undefined;
    server.use(
      http.post('/api/workspaces/:id/ticket-count', async ({ request }) => {
        sentStatus = ((await request.json()) as { status?: string }).status;
        return HttpResponse.json({ count: 7, jql: 'project = "BRIG"', active_sprint: { id: 100 } });
      }),
    );

    const wrapper = mountForm();
    await flush();

    // No trigger status yet → button disabled.
    const btn = wrapper.find('[data-test="trigger-preview-button"]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes('disabled')).toBeDefined();

    await setStatus(wrapper, 'trigger-status-select', 'Ready for Dev');
    await wrapper.find('[data-test="trigger-preview-button"]').trigger('click');
    await flush();

    expect(sentStatus).toBe('Ready for Dev');
    expect(wrapper.find('[data-test="trigger-preview-result"]').text()).toContain('7 ticket(s)');
  });

  it('renders profile options as "<type> — <model> (<name>)" / "mock (<name>)" and defaults to claude_cli', async () => {
    const wrapper = mountForm();
    await flush();

    const picker = selectByTest(wrapper, 'executor-select');
    const optionLabels = picker.findAllComponents({ name: 'ElOption' }).map((o) => o.props('label'));
    // Full profile identity — never a raw UUID; mock has no model segment.
    expect(optionLabels).toEqual(['claude_cli — claude-sonnet-5 (claude)', 'mock (mock)']);

    // A fresh form defaults to a claude_cli profile (id, not blank).
    const claude = sampleExecutors.find((e) => e.type === 'claude_cli')!;
    expect(picker.props('modelValue')).toBe(claude.id);
  });

  it('has NO Model input — the profile model is the single source of truth (2026-07-14)', async () => {
    const wrapper = mountForm();
    await flush();
    expect(wrapper.find('[data-test="model-input"]').exists()).toBe(false);
  });

  it('a disabled profile stays visible in the picker but is not selectable', async () => {
    server.use(
      http.get('/api/executors', () =>
        HttpResponse.json(paginated([...sampleExecutors, sampleDisabledExecutor])),
      ),
    );
    const wrapper = mountForm();
    await flush();

    const picker = selectByTest(wrapper, 'executor-select');
    const options = picker.findAllComponents({ name: 'ElOption' });
    const off = options.find((o) => o.props('value') === sampleDisabledExecutor.id)!;
    expect(off).toBeTruthy();
    expect(off.props('disabled')).toBe(true);
    expect(off.text()).toContain('disabled');
    // The default never lands on the disabled profile.
    expect(picker.props('modelValue')).not.toBe(sampleDisabledExecutor.id);
  });

  it('shows a non-blocking status_cycle warning yet still submits (US2 #5)', async () => {
    // Build a cycle with sampleAgent: candidate.success = B.trigger ("Ready for Dev")
    // and candidate.trigger = B.success ("In Review").
    const wrapper = mountForm();
    await flush();
    await setStatus(wrapper, 'trigger-status-select', 'In Review');
    await setStatus(wrapper, 'status-success-select', 'Ready for Dev');

    expect(wrapper.find('[data-test="status-success-warning"]').exists()).toBe(true);
    // A warning is not an error — no blocking error on the field.
    expect(wrapper.find('[data-test="status-success-error"]').exists()).toBe(false);

    let saved = false;
    server.use(
      http.post('/api/agents', () => {
        saved = true;
        return HttpResponse.json(
          { ...sampleAgent, warnings: [{ path: ['status_success'], code: 'status_cycle', message: 'cycle', level: 'warning' }] },
          { status: 201 },
        );
      }),
    );
    await wrapper.find('[data-test="name-input"]').setValue('Cyc');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(saved).toBe(true);
  });
});

describe('AgentForm — repository select (platform-scoped executors, 2026-07-13)', () => {
  const repositories = [
    { name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' },
    { name: 'infra', git_url: 'git@github.com:acme/infra.git', default_branch: 'main' },
  ];

  function mountWithRepos(agent: typeof sampleAgent | null = null) {
    return mountWithProviders(AgentForm, {
      props: { workspaceId: 'ws-1', agent, repositories },
    });
  }

  it('feature 019: lists the workspace repositories as a multi-select; empty selection = all repos', async () => {
    const wrapper = mountWithRepos();
    await flush();

    const select = selectByTest(wrapper, 'repository-select');
    expect(select.props('multiple')).toBe(true);
    const options = select.findAllComponents({ name: 'ElOption' });
    expect(options.map((o) => o.props('label'))).toEqual(['api', 'infra']);
    // A fresh form starts with the all-repositories default (empty selection).
    expect(select.props('modelValue')).toEqual([]);
  });

  it('feature 019: persists the selection into behavior.repositories and retires the legacy key', async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/agents', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sampleAgent, { status: 201 });
      }),
    );

    const wrapper = mountWithRepos();
    await flush();
    await wrapper.find('[data-test="name-input"]').setValue('Impl');
    await wrapper.find('[data-test="instruction-input"]').setValue('do it');
    await setStatus(wrapper, 'trigger-status-select', 'Ready for Dev');
    await setStatus(wrapper, 'status-success-select', 'In Review');
    await setStatus(wrapper, 'status-failure-select', 'Blocked');
    await selectByTest(wrapper, 'repository-select').setValue(['infra', 'api']);
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(posted).toBeTruthy();
    // repository scope is a BEHAVIOR key, never a top-level agent field.
    expect(posted).not.toHaveProperty('repositories');
    const behavior = posted!.behavior as Record<string, unknown>;
    expect(behavior.repositories).toEqual(['infra', 'api']);
    // Saving THIS agent moves it onto the plural form.
    expect(behavior.repository).toBeNull();
  });

  it('feature 019: seeds the multi-select from behavior.repositories on edit', async () => {
    const agent = { ...sampleAgent, behavior: { ...sampleAgent.behavior, repositories: ['api', 'infra'] } };
    const wrapper = mountWithRepos(agent);
    await flush();
    expect(selectByTest(wrapper, 'repository-select').props('modelValue')).toEqual(['api', 'infra']);
  });

  it('feature 019: a legacy behavior.repository seeds as a one-element selection (US2)', async () => {
    const agent = { ...sampleAgent, behavior: { ...sampleAgent.behavior, repository: 'api' } };
    const wrapper = mountWithRepos(agent);
    await flush();
    expect(selectByTest(wrapper, 'repository-select').props('modelValue')).toEqual(['api']);
  });
});

describe('AgentForm — orchestrator variant (feature 010)', () => {
  const orchestrator = {
    ...sampleAgent,
    id: 'ag-orch',
    name: 'brigadir',
    is_orchestrator: true,
    trigger_status: null,
    status_running: null,
    status_success: '—',
    status_failure: '—',
    behavior: { workspace_mode: 'none' },
  };

  it('hides trigger/status mapping and repository — the routing target decides the next status', async () => {
    const wrapper = mountWithProviders(AgentForm, {
      props: { workspaceId: 'ws-1', agent: orchestrator, repositories: [] },
    });
    await flush();

    for (const test of [
      'trigger-status-select',
      'trigger-jql-input',
      'status-running-select',
      'status-success-select',
      'status-failure-select',
      'repository-select',
    ]) {
      expect(wrapper.find(`[data-test="${test}"]`).exists(), test).toBe(false);
    }
    expect(wrapper.find('[data-test="orchestrator-statuses-hint"]').exists()).toBe(true);
    // Instruction stays editable (FR-019).
    expect(wrapper.find('[data-test="instruction-input"]').exists()).toBe(true);
  });

  it('saves without a board mapping — empty trigger/status fields go out as non-empty stubs (schema min(1))', async () => {
    // The orchestrator has no board-mapped statuses (trigger_status: null), so
    // the form fields are empty. The write schema requires min(1); the update
    // handler discards these fields for an orchestrator, so the form sends inert
    // stubs rather than an empty string that would 422 before that branch runs.
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/agents/ag-orch', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(orchestrator, { status: 200 });
      }),
    );

    const wrapper = mountWithProviders(AgentForm, {
      props: { workspaceId: 'ws-1', agent: orchestrator, repositories: [] },
    });
    await flush();
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(body).toBeDefined();
    expect((body!.trigger_status as string).length).toBeGreaterThan(0);
    expect((body!.status_success as string).length).toBeGreaterThan(0);
    expect((body!.status_failure as string).length).toBeGreaterThan(0);
  });

  it('a worker agent still shows the full status mapping (regression)', async () => {
    const wrapper = mountWithProviders(AgentForm, {
      props: { workspaceId: 'ws-1', agent: sampleAgent, repositories: [] },
    });
    await flush();
    expect(wrapper.find('[data-test="orchestrator-statuses-hint"]').exists()).toBe(false);
    expect(selectByTest(wrapper, 'status-success-select').exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 018 (US2) — `initialTriggerStatus` seeds the CREATE form only; the
// prop is ignored in edit mode and absent ⇒ today's empty default.
// ---------------------------------------------------------------------------

describe('AgentForm — initialTriggerStatus prefill (feature 018)', () => {
  it('seeds trigger_status in create mode', async () => {
    const wrapper = mountWithProviders(AgentForm, {
      props: { workspaceId: 'ws-1', agent: null, repositories: [], initialTriggerStatus: 'Done' },
    });
    await flush();
    expect(selectByTest(wrapper, 'trigger-status-select').props('modelValue')).toBe('Done');
  });

  it('is IGNORED in edit mode — the agent value wins', async () => {
    const wrapper = mountWithProviders(AgentForm, {
      props: {
        workspaceId: 'ws-1',
        agent: sampleAgent,
        repositories: [],
        initialTriggerStatus: 'Done',
      },
    });
    await flush();
    expect(selectByTest(wrapper, 'trigger-status-select').props('modelValue')).toBe(
      sampleAgent.trigger_status,
    );
  });

  it('is IGNORED when editing a jql-only agent (null trigger stays empty)', async () => {
    const jqlOnly = { ...sampleAgent, trigger_status: null, trigger_jql: 'labels = ops' };
    const wrapper = mountWithProviders(AgentForm, {
      props: { workspaceId: 'ws-1', agent: jqlOnly, repositories: [], initialTriggerStatus: 'Done' },
    });
    await flush();
    expect(selectByTest(wrapper, 'trigger-status-select').props('modelValue')).toBe('');
  });

  it('omitted ⇒ empty default, exactly as before', async () => {
    const wrapper = mountForm();
    await flush();
    expect(selectByTest(wrapper, 'trigger-status-select').props('modelValue')).toBe('');
  });
});

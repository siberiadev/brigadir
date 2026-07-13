import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleStatuses, sampleAgent, sampleExecutors, sampleDisabledExecutor } from './handlers';
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
    await wrapper.find('[data-test="toggle-advanced"]').trigger('click');
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
        HttpResponse.json({ items: [...sampleExecutors, sampleDisabledExecutor] }),
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

  it('lists the workspace repositories plus an explicit "workspace default" empty option', async () => {
    const wrapper = mountWithRepos();
    await flush();

    const select = selectByTest(wrapper, 'repository-select');
    const options = select.findAllComponents({ name: 'ElOption' });
    expect(options.map((o) => o.props('label'))).toEqual(['workspace default', 'api', 'infra']);
    expect(options[0].props('value')).toBe('');
    // A fresh form starts on the workspace default.
    expect(select.props('modelValue')).toBe('');
  });

  it('persists the choice into behavior.repository (null when left on the default)', async () => {
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
    await selectByTest(wrapper, 'repository-select').setValue('infra');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(posted).toBeTruthy();
    // repository is a BEHAVIOR key, never a top-level agent field.
    expect(posted).not.toHaveProperty('repository');
    expect((posted!.behavior as Record<string, unknown>).repository).toBe('infra');
  });

  it('seeds the select from an existing agent behavior.repository on edit', async () => {
    const agent = { ...sampleAgent, behavior: { ...sampleAgent.behavior, repository: 'api' } };
    const wrapper = mountWithRepos(agent);
    await flush();
    expect(selectByTest(wrapper, 'repository-select').props('modelValue')).toBe('api');
  });
});

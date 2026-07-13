import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleStatuses, sampleAgent, sampleExecutors } from './handlers';
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

  it('populates the executor picker with names + type badge and defaults to claude_cli (US4 FR-023)', async () => {
    const wrapper = mountForm();
    await flush();

    const picker = selectByTest(wrapper, 'executor-select');
    const optionLabels = picker.findAllComponents({ name: 'ElOption' }).map((o) => o.props('label'));
    // Names, never UUIDs.
    expect(optionLabels).toEqual(sampleExecutors.map((e) => e.name));

    // A fresh form defaults to the workspace's claude_cli executor (id, not blank).
    const claude = sampleExecutors.find((e) => e.type === 'claude_cli')!;
    expect(picker.props('modelValue')).toBe(claude.id);

    // The type badge renders alongside the name.
    expect(picker.findAllComponents({ name: 'ElTag' }).some((t) => t.text() === 'claude_cli')).toBe(
      true,
    );
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

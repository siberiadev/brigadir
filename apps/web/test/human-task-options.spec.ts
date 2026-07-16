import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleHumanTaskWithOptions } from './handlers';
import HumanQueue from '../src/views/HumanQueue.vue';

/**
 * Feature 013 (US1) — suggested answer options in the Human Queue drawer:
 * buttons render for a task with options; a click PRE-FILLS the answer input
 * (value ?? label) and never auto-submits; custom text stays the last option;
 * tasks with `options: null` render exactly as before (no buttons).
 */

function listWithOptionsTask() {
  server.use(
    http.get('/api/human-tasks', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      return HttpResponse.json(
        status === 'closed' ? paginated([]) : paginated([sampleHumanTaskWithOptions]),
      );
    }),
  );
}

async function openOptionsDrawer() {
  const wrapper = mountWithProviders(HumanQueue);
  await flush();
  await wrapper.find('[data-test="task-ht-opt"]').trigger('click');
  await flush();
  return wrapper;
}

const answerInput = (wrapper: Awaited<ReturnType<typeof openOptionsDrawer>>) =>
  wrapper.find('[data-test="answer-ht-opt"]').element as HTMLTextAreaElement;

describe('HumanQueue — answer option buttons (feature 013)', () => {
  it('renders one button per option with label and description; row shows the options hint', async () => {
    listWithOptionsTask();
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    expect(wrapper.find('[data-test="options-hint-ht-opt"]').text()).toContain('3 options');

    await wrapper.find('[data-test="task-ht-opt"]').trigger('click');
    await flush();

    const buttons = wrapper.findAll('[data-test="answer-options"] .answer-option');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].text()).toContain('Migrate config format');
    expect(buttons[0].text()).toContain('Breaking, needs a major bump');
    expect(buttons[1].text()).toContain('Keep backward compat');
    // The free-text field is still there below the buttons.
    expect(wrapper.find('[data-test="answer-ht-opt"]').exists()).toBe(true);
  });

  it('a click fills the answer with the option value; label-only options fill the label; last click wins', async () => {
    listWithOptionsTask();
    const wrapper = await openOptionsDrawer();

    await wrapper.find('[data-test="option-ht-opt-0"]').trigger('click');
    expect(answerInput(wrapper).value).toBe('migrate');

    // No value → label is submitted (documented default).
    await wrapper.find('[data-test="option-ht-opt-1"]').trigger('click');
    expect(answerInput(wrapper).value).toBe('Keep backward compat');

    await wrapper.find('[data-test="option-ht-opt-2"]').trigger('click');
    expect(answerInput(wrapper).value).toBe('defer');
  });

  it('a click never auto-submits — resolve fires only on the explicit submit with the filled value', async () => {
    listWithOptionsTask();
    let resolved: { id?: string; body?: unknown } = {};
    server.use(
      http.post('/api/human-tasks/:id/resolve', async ({ params, request }) => {
        resolved = { id: params.id as string, body: await request.json() };
        return HttpResponse.json({ ok: true, action: 'resume', newRunId: 'run-x' });
      }),
    );
    const wrapper = await openOptionsDrawer();

    await wrapper.find('[data-test="option-ht-opt-0"]').trigger('click');
    await flush();
    expect(resolved.id).toBeUndefined();

    await wrapper.find('[data-test="resolve-ht-opt"]').trigger('click');
    await flush();
    expect(resolved.id).toBe('ht-opt');
    expect(resolved.body).toEqual({ action: 'resume', answer: 'migrate' });
  });

  it('custom free text typed after a click overrides the option and submits as typed', async () => {
    listWithOptionsTask();
    let resolved: { body?: unknown } = {};
    server.use(
      http.post('/api/human-tasks/:id/resolve', async ({ request }) => {
        resolved = { body: await request.json() };
        return HttpResponse.json({ ok: true, action: 'resume', newRunId: 'run-x' });
      }),
    );
    const wrapper = await openOptionsDrawer();

    await wrapper.find('[data-test="option-ht-opt-0"]').trigger('click');
    await wrapper.find('[data-test="answer-ht-opt"]').setValue('Actually, do a hybrid rollout.');
    await wrapper.find('[data-test="resolve-ht-opt"]').trigger('click');
    await flush();

    expect(resolved.body).toEqual({ action: 'resume', answer: 'Actually, do a hybrid rollout.' });
  });

  it('tasks with options: null render no buttons and no hint (unchanged UI)', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    expect(wrapper.find('[data-test="options-hint-ht-1"]').exists()).toBe(false);

    await wrapper.find('[data-test="task-ht-1"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="drawer-header"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="answer-options"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="answer-ht-1"]').exists()).toBe(true);
  });
});

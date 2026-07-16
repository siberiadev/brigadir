import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleHumanQueueOpen, sampleHumanQueueClosed } from './handlers';
import HumanQueue from '../src/views/HumanQueue.vue';

/**
 * T040 — Human queue (US1). Open tasks render oldest-first as compact rows;
 * clicking a row opens the detail drawer with the markdown details and the
 * resolve form; a "resume" resolution posts the answer + action and the task
 * drops off the refreshed list; the history filter shows closed tasks with
 * their resolution + resolver on the row and in the drawer.
 */

describe('HumanQueue — open list + resolution', () => {
  it('renders the open tasks with blocking flag, ticket, agent, and age', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    expect(wrapper.find('[data-test="task-ht-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="task-ht-2"]').exists()).toBe(true);
    // Badge color encodes run state, not kind: ht-1 blocks a run (red),
    // ht-2 is non-blocking (amber). The separate "blocking" text tag is gone.
    expect(
      wrapper.find('[data-test="task-ht-1"] [data-test="kind-badge"]').attributes('data-state'),
    ).toBe('blocking');
    expect(
      wrapper.find('[data-test="task-ht-2"] [data-test="kind-badge"]').attributes('data-state'),
    ).toBe('waiting');
    expect(wrapper.find('[data-test="blocking-flag"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="task-ht-1"] [data-test="task-title"]').text()).toContain(
      'Which auth provider?',
    );
    expect(wrapper.find('[data-test="task-ht-1"] [data-test="task-ticket"]').text()).toContain(
      'BRIG-1',
    );
  });

  it('row click opens the drawer with markdown details and the resolve form', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    await wrapper.find('[data-test="task-ht-1"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="drawer-header"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="drawer-ticket"]').text()).toContain('BRIG-1');

    // details render as Markdown → HTML (heading, inline code, bold, list).
    const details = wrapper.find('[data-test="task-details"]');
    expect(details.find('h2').text()).toBe('Decision needed');
    expect(details.find('code').text()).toBe('request_human');
    expect(details.findAll('li')).toHaveLength(2);
    expect(details.find('strong').text()).toBe('OAuth');

    // the resolve form lives in the drawer footer.
    expect(wrapper.find('[data-test="answer-ht-1"]').exists()).toBe(true);
    // ht-1 blocks a run → the drawer states it explicitly.
    expect(wrapper.find('[data-test="parked-note"]').exists()).toBe(true);
  });

  it('a non-blocking task shows no parked notice in the drawer', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    // ht-2 is non-blocking → no run is parked.
    await wrapper.find('[data-test="task-ht-2"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="drawer-header"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="parked-note"]').exists()).toBe(false);
  });

  it('task without details shows a placeholder in the drawer', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    // ht-2: details null, agent null.
    await wrapper.find('[data-test="task-ht-2"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="task-details"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="drawer-no-details"]').exists()).toBe(true);
  });

  it('resume posts the answer + action, closes the drawer, and the task leaves the list', async () => {
    let resolved: { id?: string; body?: unknown } = {};
    server.use(
      http.post('/api/human-tasks/:id/resolve', async ({ params, request }) => {
        resolved = { id: params.id as string, body: await request.json() };
        return HttpResponse.json({ ok: true, action: 'resume', newRunId: 'run-x' });
      }),
    );

    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    await wrapper.find('[data-test="task-ht-1"]').trigger('click');
    await flush();
    await wrapper.find('[data-test="answer-ht-1"]').setValue('Use OAuth.');

    // After resolving ht-1, the refreshed open list no longer includes it.
    server.use(
      http.get('/api/human-tasks', () =>
        HttpResponse.json(paginated(sampleHumanQueueOpen.items.filter((t) => t.id !== 'ht-1'))),
      ),
    );

    await wrapper.find('[data-test="resolve-ht-1"]').trigger('click');
    await flush();

    expect(resolved.id).toBe('ht-1');
    expect(resolved.body).toEqual({ action: 'resume', answer: 'Use OAuth.' });
    expect(wrapper.find('[data-test="drawer-header"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="task-ht-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="task-ht-2"]').exists()).toBe(true);
  });

  it('draft answer persists across drawer close and reopen', async () => {
    // Real <transition> (stub disabled): el-drawer reports an X-button close
    // to the parent v-model only in the transition's after-leave hook.
    const wrapper = mountWithProviders(HumanQueue, {
      global: { stubs: { transition: false } },
    });
    await flush();

    await wrapper.find('[data-test="task-ht-1"]').trigger('click');
    await flush();
    await wrapper.find('[data-test="answer-ht-1"]').setValue('Half-typed thought…');

    // Closing without submitting keeps the draft (deliberate). The leave
    // transition (double rAF in jsdom) must finish before destroy-on-close
    // drops the drawer DOM — give it a beat.
    await wrapper.find('.el-drawer__close-btn').trigger('click');
    await flush(100);
    expect(wrapper.find('[data-test="drawer-header"]').exists()).toBe(false);

    await wrapper.find('[data-test="task-ht-1"]').trigger('click');
    await flush();
    const answer = wrapper.find('[data-test="answer-ht-1"]').element as HTMLTextAreaElement;
    expect(answer.value).toBe('Half-typed thought…');
  });

  it('history filter shows closed tasks with resolution + resolver', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    // Switch the filter radio group to "closed".
    await wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', 'closed');
    await flush();

    const closed = sampleHumanQueueClosed.items[0];
    const resolution = wrapper.find(`[data-test="resolution-${closed.id}"]`);
    // No status tag on the row — the green badge conveys "resolved" instead.
    expect(resolution.text()).toContain(closed.resolution!);
    expect(wrapper.find(`[data-test="resolver-${closed.id}"]`).text()).toContain('alice');
    expect(
      wrapper.find(`[data-test="task-${closed.id}"] [data-test="kind-badge"]`).attributes('data-state'),
    ).toBe('resolved');
  });

  it('closed task drawer shows the resolution and no resolve form', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    await wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', 'closed');
    await flush();

    await wrapper.find('[data-test="task-ht-9"]').trigger('click');
    await flush();

    const resolution = wrapper.find('[data-test="drawer-resolution"]');
    expect(resolution.text()).toContain('resolved');
    expect(resolution.text()).toContain('Looks good — merged.');
    expect(resolution.text()).toContain('alice');
    expect(resolution.text()).toContain('2026-07-11');
    expect(wrapper.find('[data-test="answer-ht-9"]').exists()).toBe(false);
  });
});

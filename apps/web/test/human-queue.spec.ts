import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleHumanQueueOpen, sampleHumanQueueClosed } from './handlers';
import HumanQueue from '../src/views/HumanQueue.vue';

/**
 * T040 — Human queue (US1). Open tasks render oldest-first; a "resume"
 * resolution posts the answer + action and the task drops off the refreshed
 * list; the history filter shows closed tasks with their resolution + resolver.
 */

describe('HumanQueue — open list + resolution', () => {
  it('renders the open tasks with blocking flag, ticket, agent, and age', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    expect(wrapper.find('[data-test="task-ht-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="task-ht-2"]').exists()).toBe(true);
    // ht-1 is the blocker.
    expect(wrapper.find('[data-test="task-ht-1"] [data-test="blocking-flag"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="task-ht-1"] [data-test="task-title"]').text()).toContain(
      'Which auth provider?',
    );
    expect(wrapper.find('[data-test="task-ht-1"] [data-test="task-ticket"]').text()).toContain(
      'BRIG-1',
    );
  });

  it('resume posts the answer + action, then the resolved task leaves the list', async () => {
    let resolved: { id?: string; body?: unknown } = {};
    server.use(
      http.post('/api/human-tasks/:id/resolve', async ({ params, request }) => {
        resolved = { id: params.id as string, body: await request.json() };
        return HttpResponse.json({ ok: true, action: 'resume', newRunId: 'run-x' });
      }),
    );

    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    await wrapper.find('[data-test="answer-ht-1"]').setValue('Use OAuth.');

    // After resolving ht-1, the refreshed open list no longer includes it.
    server.use(
      http.get('/api/human-tasks', () =>
        HttpResponse.json({ items: sampleHumanQueueOpen.items.filter((t) => t.id !== 'ht-1') }),
      ),
    );

    await wrapper.find('[data-test="resolve-ht-1"]').trigger('click');
    await flush();

    expect(resolved.id).toBe('ht-1');
    expect(resolved.body).toEqual({ action: 'resume', answer: 'Use OAuth.' });
    expect(wrapper.find('[data-test="task-ht-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="task-ht-2"]').exists()).toBe(true);
  });

  it('history filter shows closed tasks with resolution + resolver', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();

    // Switch the filter radio group to "closed".
    await wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', 'closed');
    await flush();

    const closed = sampleHumanQueueClosed.items[0];
    const resolution = wrapper.find(`[data-test="resolution-${closed.id}"]`);
    expect(resolution.text()).toContain('resolved');
    expect(resolution.text()).toContain(closed.resolution!);
    expect(wrapper.find(`[data-test="resolver-${closed.id}"]`).text()).toContain('alice');
  });
});

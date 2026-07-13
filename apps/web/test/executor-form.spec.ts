import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ElMessage } from 'element-plus';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleExecutors } from './handlers';
import ExecutorForm from '../src/components/ExecutorForm/ExecutorForm.vue';
import SettingsExecutors from '../src/views/settings/SettingsExecutors.vue';

/**
 * Executors admin (PLATFORM-scoped, 2026-07-13). The typed form switches its
 * field set on `type` (mock → concurrency only; claude_cli → the CLI runtime
 * fields WITHOUT repository — that's an agent choice now), create/update post
 * the typed body to the global /api/executors, and a delete-in-use 409
 * surfaces its message.
 */

function mountForm(executor: (typeof sampleExecutors)[number] | null = null) {
  return mountWithProviders(ExecutorForm, {
    props: { executor },
  });
}

describe('ExecutorForm — typed per-type fields', () => {
  it('shows only the type-appropriate fields — and NO repository field — switching on type change', async () => {
    const wrapper = mountForm();
    await flush();

    // Default type is claude_cli → CLI fields present.
    expect(wrapper.find('[data-test="executor-model"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-cli-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-max-turns"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-callback"]').exists()).toBe(true);
    // repository moved to the agent (behavior.repository) — never rendered here.
    expect(wrapper.find('[data-test="executor-repository"]').exists()).toBe(false);

    // Switch to mock → CLI fields gone, only concurrency remains.
    await wrapper
      .findAllComponents({ name: 'ElSelect' })
      .find((s) => s.attributes('data-test') === 'executor-type')!
      .setValue('mock');
    await flush();

    expect(wrapper.find('[data-test="executor-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="executor-cli-path"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="executor-concurrency"]').exists()).toBe(true);
  });

  it('creates a claude_cli executor with the typed body (no repository key) against /api/executors', async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/executors', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sampleExecutors[0], { status: 201 });
      }),
    );

    const wrapper = mountForm();
    await flush();
    await wrapper.find('[data-test="executor-name"]').setValue('builder');
    await wrapper.find('[data-test="executor-model"]').setValue('claude-opus-4-8');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(posted).toMatchObject({
      type: 'claude_cli',
      name: 'builder',
      model: 'claude-opus-4-8',
      cli_path: 'claude',
    });
    expect(posted).not.toHaveProperty('repository');
  });

  it('updates an existing executor via PUT /api/executors/:id, prefilled from its config', async () => {
    let putUrl = '';
    server.use(
      http.put('/api/executors/:executorId', ({ params }) => {
        putUrl = params.executorId as string;
        return HttpResponse.json(sampleExecutors[0]);
      }),
    );

    const wrapper = mountForm(sampleExecutors[0]);
    await flush();
    // Prefilled model from the executor's config.
    expect((wrapper.find('[data-test="executor-model"]').element as HTMLInputElement).value).toBe(
      'claude-sonnet-5',
    );
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(putUrl).toBe('ex-claude');
  });

  it('surfaces a 409 executor_name_taken as the general error', async () => {
    server.use(
      http.post('/api/executors', () =>
        HttpResponse.json(
          { error: { code: 'executor_name_taken', message: 'An executor named "claude" already exists.' } },
          { status: 409 },
        ),
      ),
    );

    const wrapper = mountForm();
    await flush();
    await wrapper.find('[data-test="executor-name"]').setValue('claude');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(wrapper.find('[data-test="executor-error"]').text()).toContain('already exists');
  });
});

describe('SettingsExecutors — delete-in-use', () => {
  it('surfaces the 409 executor_in_use message', async () => {
    const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({}) as never);
    server.use(
      http.delete('/api/executors/:executorId', () =>
        HttpResponse.json(
          {
            error: {
              code: 'executor_in_use',
              message: 'Executor "claude" is used by agents: Implementer',
            },
          },
          { status: 409 },
        ),
      ),
    );

    const wrapper = mountWithProviders(SettingsExecutors);
    await flush();

    await wrapper.find('[data-test="executor-delete-ex-claude"]').trigger('click');
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('used by agents'));
    errorSpy.mockRestore();
  });
});

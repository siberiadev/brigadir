import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ElMessage } from 'element-plus';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleExecutors, sampleWorkspace } from './handlers';
import ExecutorForm from '../src/components/ExecutorForm/ExecutorForm.vue';
import WorkspaceSettings from '../src/views/WorkspaceSettings.vue';

/**
 * T051 — Executors admin (US4). The typed form switches its field set on `type`
 * (mock → concurrency only; claude_cli → the CLI runtime fields), create/update
 * post the typed body, and a delete-in-use 409 surfaces its message.
 */

function mountForm(executor: (typeof sampleExecutors)[number] | null = null) {
  return mountWithProviders(ExecutorForm, {
    props: { workspaceId: 'ws-1', executor, repositories: sampleWorkspace.repositories },
  });
}

describe('ExecutorForm — typed per-type fields', () => {
  it('shows only the type-appropriate fields and switches on type change', async () => {
    const wrapper = mountForm();
    await flush();

    // Default type is claude_cli → CLI fields present.
    expect(wrapper.find('[data-test="executor-model"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-cli-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-max-turns"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-callback"]').exists()).toBe(true);

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

  it('creates a claude_cli executor with the typed body', async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/workspaces/:id/executors', async ({ request }) => {
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
  });

  it('updates an existing executor via PUT, prefilled from its config', async () => {
    let putUrl = '';
    server.use(
      http.put('/api/workspaces/:id/executors/:executorId', ({ params }) => {
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
});

describe('WorkspaceSettings — delete-in-use', () => {
  it('surfaces the 409 executor_in_use message', async () => {
    const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({}) as never);
    server.use(
      http.delete('/api/workspaces/:id/executors/:executorId', () =>
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

    const wrapper = mountWithProviders(WorkspaceSettings, { props: { id: sampleWorkspace.id } });
    await flush();

    await wrapper.find('[data-test="executor-delete-ex-claude"]').trigger('click');
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('used by agents'));
    errorSpy.mockRestore();
  });
});

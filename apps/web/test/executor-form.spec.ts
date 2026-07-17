import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ElMessage } from 'element-plus';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleExecutors, sampleExecutorWithKey, sampleExecutorBedrock } from './handlers';
import ExecutorForm from '../src/components/ExecutorForm/ExecutorForm.vue';
import SettingsExecutors from '../src/views/settings/SettingsExecutors.vue';

/**
 * Runner-profile form (named runner profiles, 2026-07-14). The typed form
 * switches its field set on `type` (mock → Name + Max parallel runs;
 * claude_cli → Model + CLI runtime fields + write-only API key), the Name
 * label carries the alias help tip, create/update post the typed body to the
 * global /api/executors, and a delete-in-use 409 surfaces its message.
 */

function mountForm(executor: (typeof sampleExecutors)[number] | null = null) {
  return mountWithProviders(ExecutorForm, {
    props: { executor },
  });
}

describe('ExecutorForm — typed per-type fields', () => {
  it('claude_cli shows Model + CLI fields + auth selector; NO repository field', async () => {
    const wrapper = mountForm();
    await flush();

    expect(wrapper.find('[data-test="executor-model"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-cli-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-max-turns"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-max-parallel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-callback"]').exists()).toBe(true);
    // Feature 018: auth-mode selector; per-mode fields are gated — a fresh
    // profile defaults to host_subscription, so no key/bedrock fields yet.
    expect(wrapper.find('[data-test="executor-auth"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-api-key"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="executor-aws-region"]').exists()).toBe(false);
    // repository moved to the agent (behavior.repository) — never rendered here.
    expect(wrapper.find('[data-test="executor-repository"]').exists()).toBe(false);
  });

  it('mock form is Name + Max parallel runs only', async () => {
    const wrapper = mountForm();
    await flush();
    await wrapper
      .findAllComponents({ name: 'ElSelect' })
      .find((s) => s.attributes('data-test') === 'executor-type')!
      .setValue('mock');
    await flush();

    expect(wrapper.find('[data-test="executor-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-max-parallel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="executor-cli-path"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="executor-api-key"]').exists()).toBe(false);
  });

  it('the Name label carries the alias help tip (house-style el-tooltip)', async () => {
    const wrapper = mountForm();
    await flush();

    expect(wrapper.find('[data-test="executor-name-tip"]').exists()).toBe(true);
    const tip = wrapper
      .findAllComponents({ name: 'ElTooltip' })
      .find((t) => String(t.props('content')).includes('alias for quick recognition'));
    expect(tip).toBeTruthy();
    expect(tip!.props('content')).toBe(
      'An alias for quick recognition of this runner — e.g. the team it belongs to or the user who created it.',
    );
  });

  it('creates a claude_cli profile with the typed body; untouched API key is OMITTED', async () => {
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
      max_parallel_runs: 1,
    });
    expect(posted).not.toHaveProperty('repository');
    expect(posted).not.toHaveProperty('api_key');
  });

  it('auth "api_key" reveals the key input; an entered key is POSTed as api_key', async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/executors', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...sampleExecutors[0], has_api_key: true }, { status: 201 });
      }),
    );

    const wrapper = mountForm();
    await flush();
    await wrapper
      .findAllComponents({ name: 'ElSelect' })
      .find((s) => s.attributes('data-test') === 'executor-auth')!
      .setValue('api_key');
    await flush();

    const keyInput = wrapper.find('[data-test="executor-api-key"]');
    expect(keyInput.attributes('type')).toBe('password');
    expect(keyInput.attributes('placeholder')).toBe('sk-ant-...');

    await wrapper.find('[data-test="executor-name"]').setValue('keyed');
    await keyInput.setValue('sk-ant-test-123');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(posted!.api_key).toBe('sk-ant-test-123');
    expect(posted!.auth).toBe('api_key');
  });

  it('has_api_key → "configured" + Replace/Clear actions; Replace reveals the input and PUTs the new key', async () => {
    let put: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/executors/:executorId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sampleExecutorWithKey);
      }),
    );

    const wrapper = mountForm(sampleExecutorWithKey);
    await flush();

    // configured state: status tag + actions, no input.
    expect(wrapper.find('[data-test="api-key-configured"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-api-key"]').exists()).toBe(false);

    // Replace → password input appears; a typed value rides the PUT.
    await wrapper.find('[data-test="api-key-replace"]').trigger('click');
    await flush();
    expect(wrapper.find('[data-test="executor-api-key"]').exists()).toBe(true);
    await wrapper.find('[data-test="executor-api-key"]').setValue('sk-ant-replaced');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(put!.api_key).toBe('sk-ant-replaced');
  });

  it('Clear from the configured state shows the removal note and PUTs api_key: null', async () => {
    let put: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/executors/:executorId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...sampleExecutorWithKey, has_api_key: false });
      }),
    );

    const wrapper = mountForm(sampleExecutorWithKey);
    await flush();
    await wrapper.find('[data-test="api-key-clear"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="api-key-cleared-note"]').exists()).toBe(true);
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(put!.api_key).toBeNull();
  });

  it('an untouched edit of a keyed profile OMITS api_key (keeps the stored key)', async () => {
    let put: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/executors/:executorId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sampleExecutorWithKey);
      }),
    );

    const wrapper = mountForm(sampleExecutorWithKey);
    await flush();
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();
    expect(put).not.toHaveProperty('api_key');
  });

  it('updates an existing profile via PUT /api/executors/:id, prefilled from its config', async () => {
    let putUrl = '';
    server.use(
      http.put('/api/executors/:executorId', ({ params }) => {
        putUrl = params.executorId as string;
        return HttpResponse.json(sampleExecutors[0]);
      }),
    );

    const wrapper = mountForm(sampleExecutors[0]);
    await flush();
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

/**
 * Feature 018 (T016, US4) — auth-mode selector, per-mode conditional fields,
 * bedrock model hint, and the request bodies the contract pins
 * (specs/018-bedrock-auth-mode/contracts/executor-auth.md).
 */
describe('ExecutorForm — auth modes (feature 018)', () => {
  const setAuth = async (wrapper: ReturnType<typeof mountForm>, mode: string) => {
    await wrapper
      .findAllComponents({ name: 'ElSelect' })
      .find((s) => s.attributes('data-test') === 'executor-auth')!
      .setValue(mode);
    await flush();
  };

  it('selector defaults to the response effective auth: api_key for a keyed profile, bedrock for bedrock', async () => {
    const keyed = mountForm(sampleExecutorWithKey);
    await flush();
    expect(
      keyed
        .findAllComponents({ name: 'ElSelect' })
        .find((s) => s.attributes('data-test') === 'executor-auth')!
        .props('modelValue'),
    ).toBe('api_key');
    expect(keyed.find('[data-test="api-key-configured"]').exists()).toBe(true);

    const bedrock = mountForm(sampleExecutorBedrock);
    await flush();
    expect(
      bedrock
        .findAllComponents({ name: 'ElSelect' })
        .find((s) => s.attributes('data-test') === 'executor-auth')!
        .props('modelValue'),
    ).toBe('bedrock');
  });

  it('bedrock mode shows region/profile/CA-bundle fields and the full-model-id hint; hides the key block', async () => {
    const wrapper = mountForm();
    await flush();
    await setAuth(wrapper, 'bedrock');

    expect(wrapper.find('[data-test="executor-aws-region"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-aws-profile"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-ca-bundle"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executor-api-key"]').exists()).toBe(false);
    const hint = wrapper.find('[data-test="bedrock-model-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain('eu.anthropic.claude-opus-4-8');

    await setAuth(wrapper, 'host_subscription');
    expect(wrapper.find('[data-test="executor-aws-region"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="bedrock-model-hint"]').exists()).toBe(false);
  });

  it('bedrock create POSTs auth + region (+ optional fields only when filled), never api_key', async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/executors', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sampleExecutorBedrock, { status: 201 });
      }),
    );

    const wrapper = mountForm();
    await flush();
    await setAuth(wrapper, 'bedrock');
    await wrapper.find('[data-test="executor-name"]').setValue('corp');
    await wrapper.find('[data-test="executor-aws-region"]').setValue('eu-west-1');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(posted).toMatchObject({ auth: 'bedrock', aws_region: 'eu-west-1' });
    expect(posted).not.toHaveProperty('aws_profile');
    expect(posted).not.toHaveProperty('ca_bundle_path');
    expect(posted).not.toHaveProperty('api_key');
  });

  it('editing a bedrock profile prefills its fields and PUTs them back', async () => {
    let put: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/executors/:executorId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sampleExecutorBedrock);
      }),
    );

    const wrapper = mountForm(sampleExecutorBedrock);
    await flush();
    expect(
      (wrapper.find('[data-test="executor-aws-region"]').element as HTMLInputElement).value,
    ).toBe('eu-west-1');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(put).toMatchObject({
      auth: 'bedrock',
      aws_region: 'eu-west-1',
      aws_profile: 'corp-dev',
      ca_bundle_path: '/etc/ssl/corp/ca-bundle.pem',
    });
  });

  it('switching a keyed profile to bedrock sends NO api_key (stored key stays inert, FR-009)', async () => {
    let put: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/executors/:executorId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...sampleExecutorWithKey, config: { ...sampleExecutorWithKey.config, auth: 'bedrock' } });
      }),
    );

    const wrapper = mountForm(sampleExecutorWithKey);
    await flush();
    await setAuth(wrapper, 'bedrock');
    await wrapper.find('[data-test="executor-aws-region"]').setValue('us-east-1');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    expect(put!.auth).toBe('bedrock');
    expect(put).not.toHaveProperty('api_key');
  });

  it('a 422 issue at aws_region renders under the region field', async () => {
    server.use(
      http.post('/api/executors', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_failed',
              message: 'Executor could not be saved.',
              issues: [
                { path: ['aws_region'], code: 'custom', message: 'aws_region is required when auth is "bedrock".', level: 'error' },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );

    const wrapper = mountForm();
    await flush();
    await setAuth(wrapper, 'bedrock');
    await wrapper.find('[data-test="executor-name"]').setValue('corp');
    await (wrapper.vm as unknown as { submit: () => Promise<void> }).submit();
    await flush();

    // jsdom + ElFormItem never renders the error node (verified empirically —
    // even a static `error` prop yields no .el-form-item__error), so the
    // assertion pins the wiring seam: the 422 issue landed on the REGION
    // form-item's error prop, not on the general alert.
    const regionItem = wrapper
      .findAllComponents({ name: 'ElFormItem' })
      .find((i) => i.find('[data-test="executor-aws-region"]').exists());
    expect(regionItem!.props('error')).toContain('aws_region is required');
    expect(wrapper.find('[data-test="executor-error"]').exists()).toBe(false);
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

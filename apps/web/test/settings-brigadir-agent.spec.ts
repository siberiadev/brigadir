import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  DEFAULT_BRIGADIR_AGENT_TEMPLATE,
} from '@brigadir/contracts/orchestrator-defaults';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { routes } from '../src/router';
import { setDashboardToken, clearDashboardToken } from '../src/api/token';
import App from '../src/App.vue';
// Warm the module cache so the router's lazy route components resolve
// deterministically under jsdom (the 007/009 spec pattern).
import '../src/views/settings/PlatformSettings.vue';
import '../src/views/settings/SettingsBrigadirAgent.vue';
import WorkspaceForm from '../src/components/WorkspaceForm/WorkspaceForm.vue';

/**
 * "Brigadir agent" settings section (feature 015, T015/T024): the editable
 * default-orchestrator template + both relocated instruction texts, with
 * per-field Reset, whole-template Reset-all, and 422 issue pinning; plus the
 * workspace-create seeding warning surfaced through WorkspaceForm.
 */

type Json = Record<string, unknown>;

function storedSettings(): Json {
  const template = structuredClone(DEFAULT_BRIGADIR_AGENT_TEMPLATE) as Json;
  (template as { role: string }).role = 'foreman';
  (template as { timeout_minutes: number }).timeout_minutes = 33;
  (template as { triage: { executor: string; behavior: Json } }).triage.behavior = {
    workspace_mode: 'none',
    custom_flag: 1,
  };
  return {
    template,
    routing_instruction: 'custom routing text',
    workspace_setup_instruction: 'custom setup text',
  };
}

afterEach(() => clearDashboardToken());

async function mountAt(settings: Json = storedSettings()) {
  setDashboardToken('test-token');
  server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
  server.use(http.get('/api/brigadir-agent-settings', () => HttpResponse.json(settings)));
  const wrapper = mountWithProviders(App, { routes, initialPath: '/settings/brigadir-agent' });
  await wrapper.vm.$router.isReady();
  const roleValue = () => {
    const w = wrapper.find('[data-test="template-role"] input, input[data-test="template-role"]');
    return w.exists() ? (w.element as HTMLInputElement).value : undefined;
  };
  for (let i = 0; i < 40 && roleValue() !== (settings.template as { role: string }).role; i++) {
    await flush(5);
  }
  await flush();
  return wrapper;
}

const textareaValue = (wrapper: ReturnType<typeof mountWithProviders>, testId: string) => {
  const w = wrapper.find(`textarea[data-test="${testId}"]`);
  return (w.element as HTMLTextAreaElement).value;
};

describe('SettingsBrigadirAgent — template form', () => {
  it('the settings sub-nav gains the third "Brigadir agent" item and it is active on its route', async () => {
    const wrapper = await mountAt();

    const item = wrapper.find('[data-test="settings-nav-brigadir-agent"]');
    expect(item.exists()).toBe(true);
    expect(item.text()).toBe('Brigadir agent');
    expect(item.classes()).toContain('is-active');
  });

  it('loads the stored template + both instruction texts into the form', async () => {
    const wrapper = await mountAt();

    const role = wrapper.find('[data-test="template-role"] input, input[data-test="template-role"]');
    expect((role.element as HTMLInputElement).value).toBe('foreman');
    expect(textareaValue(wrapper, 'default-orchestrator-instruction')).toBe('custom routing text');
    expect(textareaValue(wrapper, 'workspace-setup-instruction')).toBe('custom setup text');
  });

  it('per-field Reset restores each built-in text locally (US3 #2)', async () => {
    const wrapper = await mountAt();

    await wrapper.find('[data-test="reset-routing-instruction"]').trigger('click');
    await wrapper.find('[data-test="reset-setup-instruction"]').trigger('click');
    await flush();

    expect(textareaValue(wrapper, 'default-orchestrator-instruction')).toBe(
      DEFAULT_ORCHESTRATOR_INSTRUCTION,
    );
    expect(textareaValue(wrapper, 'workspace-setup-instruction')).toBe(
      DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
    );
    // Once at the default, the reset button disables.
    expect(
      wrapper.find('[data-test="reset-routing-instruction"]').attributes('disabled'),
    ).toBeDefined();
  });

  it('Save PUTs the full payload and round-trips unexposed behavior keys (analysis U1)', async () => {
    let putBody: Json | undefined;
    server.use(
      http.put('/api/brigadir-agent-settings', async ({ request }) => {
        putBody = (await request.json()) as Json;
        return HttpResponse.json(putBody);
      }),
    );
    const wrapper = await mountAt();

    await wrapper.find('[data-test="save-brigadir-agent-settings"]').trigger('click');
    await flush(10);

    expect(putBody).toBeDefined();
    const template = putBody!.template as {
      role: string;
      timeout_minutes: number;
      triage: { behavior: Json };
    };
    expect(template.role).toBe('foreman');
    expect(template.timeout_minutes).toBe(33);
    // The unexposed behavior key survives the load → save round-trip.
    expect(template.triage.behavior.custom_flag).toBe(1);
    expect(template.triage.behavior.workspace_mode).toBe('none');
    expect(putBody!.routing_instruction).toBe('custom routing text');
  });

  it('Reset all to defaults reverts every field after confirmation (US3 #3)', async () => {
    let putBody: Json | undefined;
    server.use(
      http.put('/api/brigadir-agent-settings', async ({ request }) => {
        putBody = (await request.json()) as Json;
        return HttpResponse.json(putBody);
      }),
    );
    const wrapper = await mountAt();

    await wrapper.find('[data-test="reset-all-defaults"]').trigger('click');
    await flush(5);
    // ElMessageBox renders into document.body — confirm it.
    const confirm = document.querySelector<HTMLButtonElement>(
      '.el-message-box__btns .el-button--primary',
    );
    expect(confirm).not.toBeNull();
    confirm!.click();
    await flush(10);

    const role = wrapper.find('[data-test="template-role"] input, input[data-test="template-role"]');
    expect((role.element as HTMLInputElement).value).toBe('teamlead');
    expect(textareaValue(wrapper, 'default-orchestrator-instruction')).toBe(
      DEFAULT_ORCHESTRATOR_INSTRUCTION,
    );

    // Nothing was saved yet; Save persists the defaults (incl. dropping custom_flag).
    await wrapper.find('[data-test="save-brigadir-agent-settings"]').trigger('click');
    await flush(10);
    expect(putBody).toEqual({
      template: DEFAULT_BRIGADIR_AGENT_TEMPLATE,
      routing_instruction: DEFAULT_ORCHESTRATOR_INSTRUCTION,
      workspace_setup_instruction: DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
    });
  });

  it('a 422 with field issues pins them into the issues alert', async () => {
    server.use(
      http.put('/api/brigadir-agent-settings', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_error',
              message: 'Brigadir agent settings could not be saved.',
              issues: [
                {
                  path: ['template', 'setup', 'executor'],
                  code: 'executor_unusable',
                  message: 'Executor profile "ghost" does not exist.',
                  level: 'error',
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );
    const wrapper = await mountAt();

    await wrapper.find('[data-test="save-brigadir-agent-settings"]').trigger('click');
    await flush(10);

    const alert = wrapper.find('[data-test="settings-issues"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('template.setup.executor');
    expect(alert.text()).toContain('does not exist');
  });
});

describe('workspace create — seeding warning (feature 015, FR-010)', () => {
  it('WorkspaceForm emits the response warnings alongside the new workspace id', async () => {
    server.use(
      http.post('/api/workspaces', () =>
        HttpResponse.json(
          {
            id: 'ws-new',
            warnings: [
              {
                path: ['template', 'triage', 'executor'],
                code: 'fallback',
                message:
                  'Executor profile "ghost" does not exist — orchestrator seeded on "brigadir-orchestrator".',
                level: 'warning',
              },
            ],
          },
          { status: 201 },
        ),
      ),
    );

    const wrapper = mountWithProviders(WorkspaceForm);
    // Verify (default msw handler), then create via the exposed submit()
    // (el-input forwards data-test onto the inner <input> — the form spec pattern).
    await wrapper.find('[data-test="name-input"]').setValue('Acme');
    await wrapper.find('[data-test="site-url-input"]').setValue('https://acme.atlassian.net');
    await wrapper.find('[data-test="email-input"]').setValue('bot@acme.com');
    await wrapper.find('[data-test="token-input"]').setValue('tok-123');
    await wrapper.find('[data-test="board-input"]').setValue('42');
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush(10);
    await (
      wrapper.vm as unknown as { submit: () => Promise<void> }
    ).submit();
    await flush(10);

    const emitted = wrapper.emitted('created');
    expect(emitted).toBeTruthy();
    const [id, warnings] = emitted![0] as [string, { message: string }[] | undefined];
    expect(id).toBe('ws-new');
    expect(warnings?.[0].message).toContain('brigadir-orchestrator');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
} from '@brigadir/contracts/orchestrator-defaults';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { routes } from '../src/router';
import { setDashboardToken, clearDashboardToken } from '../src/api/token';
import App from '../src/App.vue';
// Warm the module cache so the router's lazy route components resolve
// deterministically under jsdom (the 007/009 spec pattern).
import '../src/views/settings/PlatformSettings.vue';
import '../src/views/settings/SettingsExecutors.vue';
import '../src/views/settings/SettingsGeneral.vue';

/**
 * Platform Settings page (2026-07-13): /settings redirects to
 * /settings/executors; the page renders its own left sub-navigation (single
 * "Executors" item today, trivially extensible) with the executors panel —
 * the table fed by the global /api/executors — inside the content area.
 */

afterEach(() => clearDashboardToken());

/** Mount the authenticated shell at `initialPath` (the 009 spec pattern). */
async function mountAt(initialPath: string) {
  setDashboardToken('test-token');
  server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
  const wrapper = mountWithProviders(App, { routes, initialPath });
  await wrapper.vm.$router.isReady();
  // Let the redirect + lazy views + executors query settle.
  for (let i = 0; i < 40 && !wrapper.find('[data-test="executors-table"]').exists(); i++) {
    await flush(5);
  }
  await flush();
  return wrapper;
}

describe('PlatformSettings — sub-nav + executors panel', () => {
  it('/settings redirects to /settings/general', async () => {
    setDashboardToken('test-token');
    server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
    server.use(
      http.get('/api/general-settings', () =>
        HttpResponse.json({
          default_orchestrator_instruction: 'default',
          workspace_setup_instruction: 'setup default',
        }),
      ),
    );
    const wrapper = mountWithProviders(App, { routes, initialPath: '/settings' });
    await wrapper.vm.$router.isReady();
    await flush();
    expect(wrapper.vm.$route.path).toBe('/settings/general');
  });

  it('renders the left sub-navigation with the active Executors item', async () => {
    const wrapper = await mountAt('/settings/executors');

    expect(wrapper.find('[data-test="settings-subnav"]').exists()).toBe(true);
    const item = wrapper.find('[data-test="settings-nav-executors"]');
    expect(item.exists()).toBe(true);
    expect(item.text()).toBe('Executors');
    expect(item.classes()).toContain('is-active');
  });

  it('renders the executors table from the global /api/executors inside the panel', async () => {
    const wrapper = await mountAt('/settings/executors');

    expect(wrapper.find('[data-test="settings-executors-block"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="executors-table"]').exists()).toBe(true);
    const names = wrapper.findAll('[data-test="executor-name-cell"]').map((n) => n.text());
    expect(names).toEqual(['claude', 'mock']);
    expect(wrapper.find('[data-test="new-executor"]').exists()).toBe(true);
  });

  it('General renders the Theme switcher; picking Dark flips html.dark instantly (2026-07-16)', async () => {
    setDashboardToken('test-token');
    server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
    server.use(
      http.get('/api/general-settings', () =>
        HttpResponse.json({
          default_orchestrator_instruction: 'default',
          workspace_setup_instruction: 'setup default',
        }),
      ),
    );
    const wrapper = mountWithProviders(App, { routes, initialPath: '/settings/general' });
    await wrapper.vm.$router.isReady();
    for (let i = 0; i < 40 && !wrapper.find('[data-test="theme-mode"]').exists(); i++) {
      await flush(5);
    }

    expect(wrapper.find('[data-test="theme-mode"]').exists()).toBe(true);

    await wrapper.find('[data-test="theme-mode-dark"] input').setValue(true);
    await flush();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('brigadir-theme')).toBe('dark');

    await wrapper.find('[data-test="theme-mode-light"] input').setValue(true);
    await flush();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    localStorage.removeItem('brigadir-theme');
  });

  it('General shows both brigadir instruction fields; Reset to default restores the built-ins; Save PUTs both (2026-07-17)', async () => {
    setDashboardToken('test-token');
    server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
    server.use(
      http.get('/api/general-settings', () =>
        HttpResponse.json({
          default_orchestrator_instruction: 'custom routing text',
          workspace_setup_instruction: 'custom setup text',
        }),
      ),
    );
    let putBody: Record<string, string> | undefined;
    server.use(
      http.put('/api/general-settings', async ({ request }) => {
        putBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json(putBody);
      }),
    );
    const wrapper = mountWithProviders(App, { routes, initialPath: '/settings/general' });
    await wrapper.vm.$router.isReady();
    // Wait until the query resolved and seeded the fields (the textareas exist
    // empty from the first render; data-test falls through to the native textarea).
    const setupSelector = 'textarea[data-test="workspace-setup-instruction"]';
    const setupValue = () => {
      const w = wrapper.find(setupSelector);
      return w.exists() ? (w.element as HTMLTextAreaElement).value : undefined;
    };
    for (let i = 0; i < 40 && setupValue() !== 'custom setup text'; i++) {
      await flush(5);
    }

    const routing = wrapper.find('textarea[data-test="default-orchestrator-instruction"]');
    const setup = wrapper.find(setupSelector);
    expect((routing.element as HTMLTextAreaElement).value).toBe('custom routing text');
    expect((setup.element as HTMLTextAreaElement).value).toBe('custom setup text');

    // Reset each field to the built-in default (local, not yet saved).
    await wrapper.find('[data-test="reset-routing-instruction"]').trigger('click');
    await wrapper.find('[data-test="reset-setup-instruction"]').trigger('click');
    await flush();
    expect((routing.element as HTMLTextAreaElement).value).toBe(
      DEFAULT_ORCHESTRATOR_INSTRUCTION,
    );
    expect((setup.element as HTMLTextAreaElement).value).toBe(
      DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
    );

    // Save persists both fields in one PUT.
    await wrapper.find('[data-test="save-general-settings"]').trigger('click');
    await flush(10);
    expect(putBody).toEqual({
      default_orchestrator_instruction: DEFAULT_ORCHESTRATOR_INSTRUCTION,
      workspace_setup_instruction: DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
    });
  });

  it('profile table column order: Type, Model, Name, Max parallel runs, API key, Enabled (2026-07-14)', async () => {
    const wrapper = await mountAt('/settings/executors');

    const headers = wrapper
      .findAll('[data-test="executors-table"] thead th')
      .map((th) => th.text())
      .filter(Boolean); // the unnamed actions column drops out
    expect(headers).toEqual(['Type', 'Model', 'Name', 'Max parallel runs', 'API key', 'Enabled']);

    // Model shows the profile's model, em-dash for mock; API key set/—; Enabled tag.
    const models = wrapper.findAll('[data-test="executor-model-cell"]').map((n) => n.text());
    expect(models).toEqual(['claude-sonnet-5', '—']);
    const keys = wrapper.findAll('[data-test="executor-api-key-cell"]').map((n) => n.text());
    expect(keys).toEqual(['—', '—']);
    const enabled = wrapper.findAll('[data-test="executor-enabled-cell"]').map((n) => n.text());
    expect(enabled).toEqual(['enabled', 'enabled']);
  });
});

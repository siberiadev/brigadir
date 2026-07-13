import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { routes } from '../src/router';
import { setDashboardToken, clearDashboardToken } from '../src/api/token';
import App from '../src/App.vue';
// Warm the module cache so the router's lazy route components resolve
// deterministically under jsdom (the 007/009 spec pattern).
import '../src/views/settings/PlatformSettings.vue';
import '../src/views/settings/SettingsExecutors.vue';

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
  it('/settings redirects to /settings/executors', async () => {
    const wrapper = await mountAt('/settings');
    expect(wrapper.vm.$route.path).toBe('/settings/executors');
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
});

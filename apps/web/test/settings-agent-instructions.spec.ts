import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { setDashboardToken, clearDashboardToken } from '../src/api/token';
import SettingsGeneral from '../src/views/settings/SettingsGeneral.vue';

/**
 * Feature 030 US3: the GLOBAL agent role-template source card on the General
 * settings panel. Verifies the token is write-only (only a "stored / none"
 * indicator, never a value) and that saving a source PUTs the tri-state body.
 */
afterEach(() => clearDashboardToken());

async function mount(settings: { source: unknown; has_token: boolean }) {
  setDashboardToken('test-token');
  server.use(http.get('/api/agent-instructions-settings', () => HttpResponse.json(settings)));
  const wrapper = mountWithProviders(SettingsGeneral);
  for (let i = 0; i < 40; i++) {
    await flush();
    if (wrapper.find('[data-test="ai-token-state"]').exists()) break;
  }
  return wrapper;
}

describe('Agent instruction templates (global source card)', () => {
  it('renders "No token" and seeds the source url, never a token value', async () => {
    const wrapper = await mount({
      source: { git_url: 'git@github.com:acme/agents.git', subdir: 'roles' },
      has_token: false,
    });
    expect(wrapper.find('[data-test="ai-token-state"]').text()).toContain('No token');
    const url = wrapper.find('input[data-test="ai-git-url"]').element as HTMLInputElement;
    expect(url.value).toBe('git@github.com:acme/agents.git');
    // The token input is always empty (write-only replace box).
    const token = wrapper.find('input[data-test="ai-token"]').element as HTMLInputElement;
    expect(token.value).toBe('');
    // No clear-token action when nothing is stored.
    expect(wrapper.find('[data-test="ai-clear-token"]').exists()).toBe(false);
  });

  it('shows "Token stored" + a clear action when a token exists (value never rendered)', async () => {
    const wrapper = await mount({ source: null, has_token: true });
    expect(wrapper.find('[data-test="ai-token-state"]').text()).toContain('Token stored');
    expect(wrapper.find('[data-test="ai-clear-token"]').exists()).toBe(true);
    // The token field is a write-only replace box — it never holds the value.
    const token = wrapper.find('input[data-test="ai-token"]').element as HTMLInputElement;
    expect(token.value).toBe('');
  });

  it('Save PUTs the tri-state body (source set, token omitted when untouched)', async () => {
    const wrapper = await mount({ source: null, has_token: false });
    let body: unknown;
    server.use(
      http.put('/api/agent-instructions-settings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ source: null, has_token: false });
      }),
    );
    await wrapper.find('input[data-test="ai-git-url"]').setValue('https://github.com/acme/agents.git');
    await wrapper.find('[data-test="ai-save"]').trigger('click');
    for (let i = 0; i < 40 && body === undefined; i++) await flush();
    expect(body).toEqual({ source: { git_url: 'https://github.com/acme/agents.git' } });
  });
});

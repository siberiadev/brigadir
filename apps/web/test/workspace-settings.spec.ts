import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { CredentialStatus } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleWorkspace } from './handlers';
import WorkspaceSettings from '../src/views/WorkspaceSettings.vue';
import Runs from '../src/views/Runs.vue';
import HumanQueue from '../src/views/HumanQueue.vue';

/**
 * T156 — Workspace settings (US4): the expiry badge reflects the server-derived
 * credential_status, rotation re-verifies then persists (and a 422 surfaces
 * inline without dropping the stored connection), and the iteration-6 routes
 * render placeholders.
 */

function withCredentialStatus(status: CredentialStatus) {
  server.use(
    http.get('/api/workspaces', () =>
      HttpResponse.json([{ ...sampleWorkspace, credential_status: status }]),
    ),
  );
}

async function mountSettings() {
  const wrapper = mountWithProviders(WorkspaceSettings, { props: { id: sampleWorkspace.id } });
  await flush();
  return wrapper;
}

describe('WorkspaceSettings — expiry badge', () => {
  it.each([
    ['warn_30' as const, 'Expires ≤ 30 days'],
    ['warn_7' as const, 'Expires ≤ 7 days'],
    ['expired' as const, 'Token expired'],
  ])('renders the %s badge state from credential_status', async (status, label) => {
    withCredentialStatus(status);
    const wrapper = await mountSettings();
    const badge = wrapper.find('[data-test="credential-badge"]');
    expect(badge.attributes('data-status')).toBe(status);
    expect(badge.text()).toContain(label);
  });
});

describe('WorkspaceSettings — rotation', () => {
  it('re-verifies then persists a new token (US4)', async () => {
    let rotated: { jira_api_token: string } | undefined;
    server.use(
      http.put('/api/workspaces/:id/jira-connection', async ({ request }) => {
        rotated = (await request.json()) as { jira_api_token: string };
        return HttpResponse.json({ ...sampleWorkspace, credential_status: 'ok' });
      }),
    );

    const wrapper = await mountSettings();
    await wrapper.find('[data-test="rotate-email"]').setValue('bot@acme.com');
    await wrapper.find('[data-test="rotate-token"]').setValue('new-token');
    await wrapper.find('[data-test="reconnect-button"]').trigger('click');
    await flush();

    expect(rotated?.jira_api_token).toBe('new-token');
    expect(wrapper.find('[data-test="rotate-error"]').exists()).toBe(false);
  });

  it('surfaces a re-verify 422 inline without clearing the stored connection', async () => {
    server.use(
      http.put('/api/workspaces/:id/jira-connection', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_failed',
              message: 'Token could not be verified.',
              issues: [
                {
                  path: ['jira_api_token'],
                  code: 'token_invalid',
                  message: 'Token could not be verified.',
                  level: 'error',
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );

    const wrapper = await mountSettings();
    await wrapper.find('[data-test="rotate-token"]').setValue('bad-token');
    await wrapper.find('[data-test="reconnect-button"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="rotate-error"]').text()).toContain('Token could not be verified.');
    // The stored connection is untouched — the workspace's site/project still show.
    expect(wrapper.text()).toContain(sampleWorkspace.jira_site_url);
    expect(wrapper.text()).toContain(sampleWorkspace.project_key);
  });
});

describe('placeholder routes', () => {
  it('renders the Runs placeholder (iteration-6 stub)', async () => {
    const wrapper = mountWithProviders(Runs);
    await flush();
    expect(wrapper.find('[data-test="runs-placeholder"]').exists()).toBe(true);
  });

  it('renders the Human queue placeholder (iteration-6 stub)', async () => {
    const wrapper = mountWithProviders(HumanQueue);
    await flush();
    expect(wrapper.find('[data-test="human-queue-placeholder"]').exists()).toBe(true);
  });
});

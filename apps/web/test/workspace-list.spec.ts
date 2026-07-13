import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleWorkspace } from './handlers';
import WorkspaceList from '../src/views/WorkspaceList.vue';

/**
 * Workspace list (feature 006, US5) — the Running/Paused status column reflects
 * `enabled`, and the inline Start/Pause action writes `settings.enabled` via the
 * settings endpoint (the toggle lives in the list, not the settings modal).
 */

describe('WorkspaceList — status + inline pause', () => {
  it('shows the Running status for an enabled workspace', async () => {
    const wrapper = mountWithProviders(WorkspaceList);
    await flush();
    expect(wrapper.find('[data-test="workspace-status"]').text()).toBe('Running');
  });

  it('shows the Paused status for a disabled workspace', async () => {
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json([{ ...sampleWorkspace, enabled: false }])),
    );
    const wrapper = mountWithProviders(WorkspaceList);
    await flush();
    expect(wrapper.find('[data-test="workspace-status"]').text()).toBe('Paused');
  });

  it('pauses a running workspace inline via the settings endpoint', async () => {
    let body: { enabled?: boolean } | undefined;
    server.use(
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        body = (await request.json()) as { enabled?: boolean };
        return HttpResponse.json({ ...sampleWorkspace, enabled: false });
      }),
    );

    const wrapper = mountWithProviders(WorkspaceList);
    await flush();

    // Enabled workspace → the action reads "Pause".
    const btn = wrapper.find(`[data-test="toggle-pause-${sampleWorkspace.id}"]`);
    expect(btn.text()).toBe('Pause');
    await btn.trigger('click');
    await flush();

    expect(body?.enabled).toBe(false);
  });
});

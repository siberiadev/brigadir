import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleWorkspace } from './handlers';
import WorkspaceHeader from '../src/components/WorkspaceHeader/WorkspaceHeader.vue';

/**
 * Workspace header — Start/Pause next to the title, so a running workspace can
 * be stopped from its own page instead of only from the list (same
 * `settings.enabled` write as the WorkspaceList inline action).
 */

function mountHeader() {
  return mountWithProviders(WorkspaceHeader, { props: { id: sampleWorkspace.id } });
}

describe('WorkspaceHeader — inline start/pause', () => {
  it('shows Running + a Pause action for an enabled workspace', async () => {
    const wrapper = mountHeader();
    await flush();

    expect(wrapper.find('[data-test="workspace-header-status"]').text()).toBe('Running');
    expect(wrapper.find('[data-test="workspace-header-toggle-pause"]').text()).toBe('Pause');
  });

  it('shows Paused + a Start action for a disabled workspace', async () => {
    server.use(
      http.get('/api/workspaces/:id', () =>
        HttpResponse.json({ ...sampleWorkspace, enabled: false }),
      ),
    );
    const wrapper = mountHeader();
    await flush();

    expect(wrapper.find('[data-test="workspace-header-status"]').text()).toBe('Paused');
    expect(wrapper.find('[data-test="workspace-header-toggle-pause"]').text()).toBe('Start');
  });

  it('hides the status and action until the workspace resolves', () => {
    const wrapper = mountHeader();
    // No flush: the query is still in flight, so `enabled` is only a default —
    // rendering it would flash the wrong label.
    expect(wrapper.find('[data-test="workspace-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="workspace-header-toggle-pause"]').exists()).toBe(false);
  });

  it('pauses a running workspace via the settings endpoint', async () => {
    let body: { enabled?: boolean } | undefined;
    server.use(
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        body = (await request.json()) as { enabled?: boolean };
        return HttpResponse.json({ ...sampleWorkspace, enabled: false });
      }),
    );

    const wrapper = mountHeader();
    await flush();
    await wrapper.find('[data-test="workspace-header-toggle-pause"]').trigger('click');
    await flush();

    expect(body?.enabled).toBe(false);
  });

  it('starts a paused workspace via the settings endpoint', async () => {
    let body: { enabled?: boolean } | undefined;
    server.use(
      http.get('/api/workspaces/:id', () =>
        HttpResponse.json({ ...sampleWorkspace, enabled: false }),
      ),
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        body = (await request.json()) as { enabled?: boolean };
        return HttpResponse.json(sampleWorkspace);
      }),
    );

    const wrapper = mountHeader();
    await flush();
    await wrapper.find('[data-test="workspace-header-toggle-pause"]').trigger('click');
    await flush();

    expect(body?.enabled).toBe(true);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import type { RouteRecordNormalized } from 'vue-router';
import type { WorkspaceResponse } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleWorkspace, nullableWorkspace } from './handlers';
import { routes } from '../src/router';
import WorkspaceSettings from '../src/views/WorkspaceSettings.vue';
// Warm the lazy route-component cache for the deep-link (US3) tests.
import '../src/views/WorkspacePage.vue';
import '../src/views/AgentsList.vue';
import '../src/views/Runs.vue';
import '../src/views/WorkspaceSettings.vue';

/**
 * Feature 008 — Workspace Settings tab. The read-only `el-descriptions` blocks
 * (US1), the Edit-modal round-trips seeded from persisted values (US2), the
 * settings deep-link resolving to the tab (US3), and the FormDialog reopen-race
 * regression (US4). The API boundary stays faked by msw; the Edit modals
 * teleport to `document.body` (append-to-body), so their content is queried on
 * the document, not the wrapper subtree.
 */

let active: VueWrapper | undefined;

afterEach(() => {
  active?.unmount();
  active = undefined;
  // Element Plus dialogs teleport to <body>; scrub any lingering overlay between
  // tests so a stale modal never leaks into the next assertion.
  document.body.querySelectorAll('.el-overlay, .el-dialog__wrapper').forEach((n) => n.remove());
});

function serveWorkspace(ws: WorkspaceResponse) {
  // Settings резолвит workspace через detail-эндпоинт (реш. 2026-07-15).
  server.use(http.get('/api/workspaces/:id', () => HttpResponse.json(ws)));
}

async function mountSettings(ws: WorkspaceResponse = sampleWorkspace) {
  serveWorkspace(ws);
  const wrapper = mountWithProviders(WorkspaceSettings, { props: { id: ws.id } });
  active = wrapper;
  await flush();
  return wrapper;
}

const bodyQ = (sel: string) =>
  document.querySelector(`[data-test="${sel}"]`) as HTMLElement | null;

async function openModal(wrapper: VueWrapper, editBtn: string) {
  await wrapper.find(`[data-test="${editBtn}"]`).trigger('click');
  await flush();
}

async function setBodyInput(sel: string, value: string) {
  const el = bodyQ(sel) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flush();
}

async function clickBody(sel: string) {
  bodyQ(sel)!.click();
  await flush();
}

// --------------------------------------------------------------------------
// US1 — read-only Settings tab
// --------------------------------------------------------------------------

describe('WorkspaceSettings — read-only blocks (US1)', () => {
  it('renders the Jira + config blocks as read-only el-descriptions with no editable inputs', async () => {
    const wrapper = await mountSettings();

    expect(wrapper.find('[data-test="settings-jira-block"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="settings-config-block"]').exists()).toBe(true);
    // Executors admin moved to the PLATFORM Settings page (/settings/executors,
    // 2026-07-13) — the workspace tab keeps Jira connection + Configuration only.
    expect(wrapper.find('[data-test="settings-executors-block"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="executors-table"]').exists()).toBe(false);

    // The read-only view has NO editable input controls (SC-001) — inputs live
    // only inside the (closed) Edit modals. The one sanctioned exception is the
    // feature-020 ticket-scoping el-switch (a standalone toggle like the list's
    // enable/pause switch), whose hidden checkbox input is excluded here.
    const textInputs = wrapper.findAll('input').filter((i) => i.attributes('type') !== 'checkbox');
    expect(textInputs.length).toBe(0);

    // Feature 020 (D2b): the ticket-scoping toggle renders and reflects the
    // persisted flag (sampleWorkspace carries ticket_scoping: false ⇒ off).
    expect(wrapper.find('[data-test="config-ticket-scoping"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="config-ticket-scoping"]').classes()).not.toContain('is-checked');

    // Actual values surface.
    expect(wrapper.find('[data-test="jira-site"]').text()).toBe(sampleWorkspace.jira_site_url);
    expect(wrapper.find('[data-test="jira-project"]').text()).toBe(sampleWorkspace.project_key);
    expect(wrapper.find('[data-test="jira-bot-email"]').text()).toBe(sampleWorkspace.bot_email);
    expect(wrapper.find('[data-test="config-branch-prefix"]').text()).toBe(
      sampleWorkspace.branch_prefix,
    );
    expect(wrapper.find('[data-test="credential-status"]').exists()).toBe(true);
  });

  it('tags the first repository as the default', async () => {
    const wrapper = await mountSettings();
    expect(wrapper.find('[data-test="config-repo-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="config-repo-default-tag"]').exists()).toBe(true);
  });

  it('degrades nullable values to placeholders, no phantom default tag (FR-015)', async () => {
    const wrapper = await mountSettings(nullableWorkspace);

    expect(wrapper.find('[data-test="jira-board"]').text()).toBe('Not configured');
    expect(wrapper.find('[data-test="jira-token-expiry"]').text()).toBe('No expiry');
    expect(wrapper.find('[data-test="jira-bot-email"]').text()).toBe('—');
    expect(wrapper.find('[data-test="config-repos-empty"]').text()).toContain(
      'No repositories configured',
    );
    expect(wrapper.find('[data-test="config-repo-default-tag"]').exists()).toBe(false);
  });
});

// --------------------------------------------------------------------------
// US2 — Edit connection & configuration via modals
// --------------------------------------------------------------------------

describe('WorkspaceSettings — Edit modals (US2)', () => {
  it('opens the connection modal seeded from bot_email and round-trips a rotation', async () => {
    let rotated: { jira_api_token: string } | undefined;
    server.use(
      http.put('/api/workspaces/:id/jira-connection', async ({ request }) => {
        rotated = (await request.json()) as { jira_api_token: string };
        return HttpResponse.json({ ...sampleWorkspace, credential_status: 'ok' });
      }),
    );

    const wrapper = await mountSettings();
    await openModal(wrapper, 'edit-jira-connection');

    // Seeded from the PERSISTED bot_email, not blank.
    expect((bodyQ('rotate-email') as HTMLInputElement).value).toBe(sampleWorkspace.bot_email);

    await setBodyInput('rotate-token', 'new-token');
    await clickBody('reconnect-button');
    await flush();

    expect(rotated?.jira_api_token).toBe('new-token');
    // Modal closed (destroy-on-close → body gone).
    expect(bodyQ('rotate-email')).toBeNull();
  });

  it('opens the config modal seeded from PERSISTED values (not `feat`/empty) and updates the block', async () => {
    let current: WorkspaceResponse = { ...sampleWorkspace };
    server.use(
      http.get('/api/workspaces/:id', () => HttpResponse.json(current)),
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        const body = (await request.json()) as { branch_prefix?: string };
        current = { ...current, branch_prefix: body.branch_prefix ?? null };
        return HttpResponse.json(current);
      }),
    );

    const wrapper = mountWithProviders(WorkspaceSettings, { props: { id: sampleWorkspace.id } });
    active = wrapper;
    await flush();

    await openModal(wrapper, 'edit-config');

    // The seeded value equals the STORED prefix, NOT the hard-coded `feat`.
    expect((bodyQ('branch-prefix') as HTMLInputElement).value).toBe(sampleWorkspace.branch_prefix);
    expect(sampleWorkspace.branch_prefix).not.toBe('feat');
    // Advanced scope pane seeds the persisted JQL.
    expect((bodyQ('scope-jql') as HTMLInputElement).value).toBe(sampleWorkspace.scope_jql);

    await setBodyInput('branch-prefix', 'hotfix');
    await clickBody('save-settings');
    await flush();
    await flush();

    // Modal closed and the read-only block reflects the saved value (FR-007).
    expect(bodyQ('branch-prefix')).toBeNull();
    expect(wrapper.find('[data-test="config-branch-prefix"]').text()).toBe('hotfix');
  });

  it('cancelling the config modal sends no request and leaves data unchanged (FR-008)', async () => {
    let putCalls = 0;
    server.use(
      http.put('/api/workspaces/:id/settings', () => {
        putCalls += 1;
        return HttpResponse.json(sampleWorkspace);
      }),
    );

    const wrapper = await mountSettings();
    await openModal(wrapper, 'edit-config');
    expect(bodyQ('branch-prefix')).not.toBeNull();

    await clickBody('config-cancel');
    await flush();

    expect(putCalls).toBe(0);
    expect(bodyQ('branch-prefix')).toBeNull();
    expect(wrapper.find('[data-test="config-branch-prefix"]').text()).toBe(
      sampleWorkspace.branch_prefix,
    );
  });

  it('surfaces a re-verify 422 inline and keeps the modal open + connection intact', async () => {
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
    await openModal(wrapper, 'edit-jira-connection');
    await setBodyInput('rotate-token', 'bad-token');
    await clickBody('reconnect-button');
    await flush();

    expect(bodyQ('rotate-error')?.textContent).toContain('Token could not be verified.');
    // Modal stays open (still editable) and the stored connection is untouched.
    expect(bodyQ('rotate-email')).not.toBeNull();
    expect(wrapper.find('[data-test="jira-site"]').text()).toBe(sampleWorkspace.jira_site_url);
  });
});

// --------------------------------------------------------------------------
// US3 — Settings deep-link resolves to the tab
// --------------------------------------------------------------------------

const AppRoot = { template: '<router-view />' };

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await flush(5);
  await flush();
}

describe('WorkspaceSettings — routing (US3)', () => {
  it('direct visit to /workspaces/:id/settings resolves route `settings` with the tab content', async () => {
    const wrapper = mountWithProviders(AppRoot, {
      routes,
      initialPath: '/workspaces/ws-1/settings',
    });
    active = wrapper;
    const router = wrapper.vm.$router;
    await router.isReady();
    await settle(() => wrapper.find('[data-test="settings-jira-block"]').exists());

    expect(router.currentRoute.value.name).toBe('settings');
    expect(wrapper.find('[data-test="workspace-tabs"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="settings-jira-block"]').exists()).toBe(true);
  });

  it('has no standalone `workspace-settings` route and falls back unknown tabs to runs', async () => {
    const wrapper = mountWithProviders(AppRoot, {
      routes,
      initialPath: '/workspaces/ws-1/agents',
    });
    active = wrapper;
    const router = wrapper.vm.$router;
    await router.isReady();
    await flush();

    // The retired standalone page leaves no route behind.
    expect(
      router.getRoutes().some((r: RouteRecordNormalized) => r.name === 'workspace-settings'),
    ).toBe(false);
    // settings still out-ranks the catch-all…
    expect(router.resolve('/workspaces/ws-1/settings').name).toBe('settings');
    // …and an unknown tab still redirects to runs — the default tab
    // (реш. 2026-07-15; catchAll ordering intact).
    router.push('/workspaces/ws-1/nope');
    await settle(
      () =>
        router.currentRoute.value.name === 'runs' &&
        router.currentRoute.value.path === '/workspaces/ws-1/runs',
    );
    expect(router.currentRoute.value.name).toBe('runs');
  });
});

// --------------------------------------------------------------------------
// US4 — Reopening an edit modal always shows content (FormDialog reopen race)
// --------------------------------------------------------------------------

describe('WorkspaceSettings — FormDialog reopen race (US4)', () => {
  it('reopening an Edit modal within the close window re-renders its form body (SC-004)', async () => {
    const wrapper = await mountSettings();

    // Open, then close (without waiting for the close transition to finish).
    await openModal(wrapper, 'edit-config');
    expect(bodyQ('branch-prefix')).not.toBeNull();
    await clickBody('config-cancel');

    // Reopen immediately — destroy-on-close must re-mount a fresh body, not an
    // empty title+footer shell.
    await openModal(wrapper, 'edit-config');
    await flush();

    expect(bodyQ('branch-prefix')).not.toBeNull();
    expect((bodyQ('branch-prefix') as HTMLInputElement).value).toBe(sampleWorkspace.branch_prefix);
  });
});

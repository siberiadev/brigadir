import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import type { RouteRecordNormalized } from 'vue-router';
import type { WorkspaceResponse } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleWorkspace, nullableWorkspace } from './handlers';
import { routes } from '../src/router';
import GeneralPanel from '../src/views/workspace-settings/GeneralPanel.vue';
import JiraPanel from '../src/views/workspace-settings/JiraPanel.vue';
import EnvironmentPanel from '../src/views/workspace-settings/EnvironmentPanel.vue';
import AgentsPanel from '../src/views/workspace-settings/AgentsPanel.vue';
// Warm the lazy route-component cache for the deep-link (routing) tests.
import '../src/views/WorkspacePage.vue';
import '../src/views/AgentsList.vue';
import '../src/views/Runs.vue';
import '../src/views/WorkspaceSettings.vue';

/**
 * Feature 031 — Workspace Settings restructure into sidebar sections (General /
 * Jira connection / Environment / Agents), each its own nested route. Panels are
 * mounted directly for their read-only + Edit-modal behavior; the full router is
 * used for the deep-link / redirect / sub-nav wiring. The API boundary stays
 * faked by msw; Edit modals teleport to <body>.
 */

let active: VueWrapper | undefined;

afterEach(() => {
  active?.unmount();
  active = undefined;
  document.body.querySelectorAll('.el-overlay, .el-dialog__wrapper').forEach((n) => n.remove());
});

function serveWorkspace(ws: WorkspaceResponse) {
  server.use(http.get('/api/workspaces/:id', () => HttpResponse.json(ws)));
}

async function mountPanel(panel: unknown, ws: WorkspaceResponse = sampleWorkspace) {
  serveWorkspace(ws);
  const wrapper = mountWithProviders(panel as never, { props: { id: ws.id } });
  active = wrapper;
  await flush();
  return wrapper;
}

const bodyQ = (sel: string) => document.querySelector(`[data-test="${sel}"]`) as HTMLElement | null;

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
// Read-only panels
// --------------------------------------------------------------------------

describe('Settings panels — read-only blocks', () => {
  it('Jira panel renders the connection block with values and no text inputs', async () => {
    const wrapper = await mountPanel(JiraPanel);
    expect(wrapper.find('[data-test="settings-jira-block"]').exists()).toBe(true);
    expect(wrapper.findAll('input').filter((i) => i.attributes('type') !== 'checkbox').length).toBe(0);
    expect(wrapper.find('[data-test="jira-site"]').text()).toBe(sampleWorkspace.jira_site_url);
    expect(wrapper.find('[data-test="jira-project"]').text()).toBe(sampleWorkspace.project_key);
    expect(wrapper.find('[data-test="jira-bot-email"]').text()).toBe(sampleWorkspace.bot_email);
  });

  it('General panel renders branch/scope + the ticket-scoping toggle', async () => {
    const wrapper = await mountPanel(GeneralPanel);
    expect(wrapper.find('[data-test="settings-config-block"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="config-branch-prefix"]').text()).toBe(sampleWorkspace.branch_prefix);
    expect(wrapper.find('[data-test="config-ticket-scoping"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="config-ticket-scoping"]').classes()).not.toContain('is-checked');
    // No repositories on the General panel (they moved to Environment).
    expect(wrapper.find('[data-test="config-repo-0"]').exists()).toBe(false);
  });

  it('Environment panel tags the first repository as default', async () => {
    const wrapper = await mountPanel(EnvironmentPanel);
    expect(wrapper.find('[data-test="config-repo-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="config-repo-default-tag"]').exists()).toBe(true);
  });

  it('Environment panel degrades an empty repo list to a placeholder (no phantom tag)', async () => {
    const wrapper = await mountPanel(EnvironmentPanel, nullableWorkspace);
    expect(wrapper.find('[data-test="config-repos-empty"]').text()).toContain('No repositories configured');
    expect(wrapper.find('[data-test="config-repo-default-tag"]').exists()).toBe(false);
  });

  it('Jira panel degrades nullable board/expiry/email to placeholders', async () => {
    const wrapper = await mountPanel(JiraPanel, nullableWorkspace);
    expect(wrapper.find('[data-test="jira-board"]').text()).toBe('Not configured');
    expect(wrapper.find('[data-test="jira-token-expiry"]').text()).toBe('No expiry');
    expect(wrapper.find('[data-test="jira-bot-email"]').text()).toBe('—');
  });
});

// --------------------------------------------------------------------------
// Edit modals
// --------------------------------------------------------------------------

describe('Settings panels — Edit modals', () => {
  it('Jira panel opens the connection modal seeded from bot_email and rotates', async () => {
    let rotated: { jira_api_token: string } | undefined;
    server.use(
      http.put('/api/workspaces/:id/jira-connection', async ({ request }) => {
        rotated = (await request.json()) as { jira_api_token: string };
        return HttpResponse.json({ ...sampleWorkspace, credential_status: 'ok' });
      }),
    );
    const wrapper = await mountPanel(JiraPanel);
    await openModal(wrapper, 'edit-jira-connection');
    expect((bodyQ('rotate-email') as HTMLInputElement).value).toBe(sampleWorkspace.bot_email);
    await setBodyInput('rotate-token', 'new-token');
    await clickBody('reconnect-button');
    await flush();
    expect(rotated?.jira_api_token).toBe('new-token');
    expect(bodyQ('rotate-email')).toBeNull();
  });

  it('General panel edit modal seeds persisted values and saves branch prefix', async () => {
    let current: WorkspaceResponse = { ...sampleWorkspace };
    server.use(
      http.get('/api/workspaces/:id', () => HttpResponse.json(current)),
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        const body = (await request.json()) as { branch_prefix?: string };
        current = { ...current, branch_prefix: body.branch_prefix ?? null };
        return HttpResponse.json(current);
      }),
    );
    const wrapper = mountWithProviders(GeneralPanel, { props: { id: sampleWorkspace.id } });
    active = wrapper;
    await flush();
    await openModal(wrapper, 'edit-config');
    expect((bodyQ('branch-prefix') as HTMLInputElement).value).toBe(sampleWorkspace.branch_prefix);
    expect(sampleWorkspace.branch_prefix).not.toBe('feat');
    expect((bodyQ('scope-jql') as HTMLInputElement).value).toBe(sampleWorkspace.scope_jql);
    await setBodyInput('branch-prefix', 'hotfix');
    await clickBody('save-settings');
    await flush();
    await flush();
    expect(bodyQ('branch-prefix')).toBeNull();
    expect(wrapper.find('[data-test="config-branch-prefix"]').text()).toBe('hotfix');
  });

  it('General panel: cancelling sends no request and leaves data unchanged', async () => {
    let putCalls = 0;
    server.use(
      http.put('/api/workspaces/:id/settings', () => {
        putCalls += 1;
        return HttpResponse.json(sampleWorkspace);
      }),
    );
    const wrapper = await mountPanel(GeneralPanel);
    await openModal(wrapper, 'edit-config');
    expect(bodyQ('branch-prefix')).not.toBeNull();
    await clickBody('config-cancel');
    await flush();
    expect(putCalls).toBe(0);
    expect(bodyQ('branch-prefix')).toBeNull();
    expect(wrapper.find('[data-test="config-branch-prefix"]').text()).toBe(sampleWorkspace.branch_prefix);
  });

  it('Environment panel: workspace-defaults Edit opens ONLY the workspace env table (no repos)', async () => {
    const wrapper = await mountPanel(EnvironmentPanel);
    await openModal(wrapper, 'edit-environment');
    expect(bodyQ('ws-env')).not.toBeNull();
    // Repositories are NOT in this modal any more — they are per-card.
    expect(bodyQ('repo-form-name')).toBeNull();
    await clickBody('environment-cancel');
    await flush();
    expect(bodyQ('ws-env')).toBeNull();
  });

  it('Environment panel: each repo card has its own Edit → single-repo form seeded from that repo', async () => {
    const wrapper = await mountPanel(EnvironmentPanel);
    await openModal(wrapper, 'edit-repo-0');
    // data-test forwards to the inner <input>; seeded from the first repo.
    expect((bodyQ('repo-form-name') as HTMLInputElement).value).toBe(sampleWorkspace.repositories[0].name);
    expect(bodyQ('repo-remove')).not.toBeNull();
    expect(bodyQ('repo-form-new-hint')).toBeNull(); // existing repo (has id) → secrets allowed
  });

  it('Environment panel: Add repository opens an empty create form (secrets gated until first save)', async () => {
    const wrapper = await mountPanel(EnvironmentPanel);
    await openModal(wrapper, 'add-repo');
    expect((bodyQ('repo-form-name') as HTMLInputElement).value).toBe('');
    // No id yet → secret vars are gated with a hint, and no Remove button.
    expect(bodyQ('repo-form-new-hint')).not.toBeNull();
    expect(bodyQ('repo-remove')).toBeNull();
  });

  it('Environment panel: saving a repo edit PATCHes the FULL repositories array with that repo updated', async () => {
    let sent: { repositories?: { name: string }[] } | undefined;
    server.use(
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        sent = (await request.json()) as { repositories?: { name: string }[] };
        return HttpResponse.json(sampleWorkspace);
      }),
    );
    const wrapper = await mountPanel(EnvironmentPanel);
    await openModal(wrapper, 'edit-repo-0');
    await setBodyInput('repo-form-name', 'renamed-repo');
    await clickBody('repo-save');
    await flush();
    await flush();
    // The whole array is sent (settings PATCH replaces it), with only repo 0 renamed.
    expect(sent?.repositories?.length).toBe(sampleWorkspace.repositories.length);
    expect(sent?.repositories?.[0].name).toBe('renamed-repo');
    expect(bodyQ('repo-form-name')).toBeNull(); // modal closed
  });

  it('Agents panel renders the instructions-source block and opens its editor', async () => {
    const wrapper = await mountPanel(AgentsPanel);
    expect(wrapper.find('[data-test="agent-instructions-block"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="ai-token-state"]').text()).toContain('No token');
    await openModal(wrapper, 'edit-agent-instructions');
    expect(bodyQ('ai-git-url')).not.toBeNull();
  });

  it('General panel: 422 on the connection is a Jira-panel concern; scope preview works here', async () => {
    server.use(
      http.post('/api/workspaces/:id/ticket-count', () =>
        HttpResponse.json({ count: 12, jql: 'project = "BRIG"', active_sprint_ids: [] }),
      ),
    );
    const wrapper = await mountPanel(GeneralPanel);
    await openModal(wrapper, 'edit-config');
    const btn = bodyQ('scope-preview-button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    btn.click();
    await flush();
    await flush();
    expect(bodyQ('scope-preview-result')?.textContent).toContain('12 ticket(s)');
    await setBodyInput('scope-jql', 'labels = changed');
    expect((bodyQ('scope-preview-button') as HTMLButtonElement).disabled).toBe(true);
    expect(bodyQ('scope-preview-dirty')).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// Routing — the settings shell + nested sub-routes
// --------------------------------------------------------------------------

const AppRoot = { template: '<router-view />' };

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await flush(5);
  await flush();
}

describe('WorkspaceSettings — routing', () => {
  it('/workspaces/:id/settings redirects to General and renders the sub-nav', async () => {
    serveWorkspace(sampleWorkspace);
    const wrapper = mountWithProviders(AppRoot, { routes, initialPath: '/workspaces/ws-1/settings' });
    active = wrapper;
    const router = wrapper.vm.$router;
    await router.isReady();
    await settle(() => wrapper.find('[data-test="settings-config-block"]').exists());

    // The empty settings child redirects to General.
    expect(router.currentRoute.value.name).toBe('settings-general');
    // The sub-nav + the General panel render; the top tab strip is still present.
    expect(wrapper.find('[data-test="workspace-settings-subnav"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="workspace-tabs"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="settings-config-block"]').exists()).toBe(true);
    // The settings child pins the top-level Settings tab via meta.tab.
    expect(router.currentRoute.value.meta.tab).toBe('settings');
  });

  it('navigating the sub-nav swaps panels (Environment shows the repo list)', async () => {
    serveWorkspace(sampleWorkspace);
    const wrapper = mountWithProviders(AppRoot, { routes, initialPath: '/workspaces/ws-1/settings/general' });
    active = wrapper;
    const router = wrapper.vm.$router;
    await router.isReady();
    await settle(() => wrapper.find('[data-test="settings-config-block"]').exists());

    router.push('/workspaces/ws-1/settings/environment');
    await settle(() => wrapper.find('[data-test="config-repo-0"]').exists());
    expect(router.currentRoute.value.name).toBe('settings-environment');
    expect(wrapper.find('[data-test="config-repo-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="settings-config-block"]').exists()).toBe(false);
  });

  it('has no standalone `workspace-settings` route and unknown tabs fall back to runs', async () => {
    const wrapper = mountWithProviders(AppRoot, { routes, initialPath: '/workspaces/ws-1/agents' });
    active = wrapper;
    const router = wrapper.vm.$router;
    await router.isReady();
    await flush();

    expect(router.getRoutes().some((r: RouteRecordNormalized) => r.name === 'workspace-settings')).toBe(false);
    expect(router.resolve('/workspaces/ws-1/settings/general').name).toBe('settings-general');
    router.push('/workspaces/ws-1/nope');
    await settle(
      () =>
        router.currentRoute.value.name === 'runs' &&
        router.currentRoute.value.path === '/workspaces/ws-1/runs',
    );
    expect(router.currentRoute.value.name).toBe('runs');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import type { RouteRecordNormalized } from 'vue-router';
import type { WorkspaceResponse } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleWorkspace, nullableWorkspace } from './handlers';
import { routes } from '../src/router';
import { SECRET_MASK } from '../src/components/BulkEnvEditor/bulk-env';
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
/** The dependency-release-status ElSelect inside the (teleported) Edit modal. */
function releaseSelect(wrapper: VueWrapper) {
  const el = wrapper
    .findAllComponents({ name: 'ElSelect' })
    .find((s) => s.attributes('data-test') === 'dependency-release-status');
  if (!el) throw new Error('no ElSelect with data-test=dependency-release-status');
  return el;
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

  it('Environment panel read-only list shows key | value | type with masked secrets, no tag', async () => {
    const ws = {
      ...sampleWorkspace,
      env: { LOG_LEVEL: 'info' },
      env_secret_keys: { workspace: ['API_TOKEN'], repos: {}, agents: {} },
    };
    const wrapper = await mountPanel(EnvironmentPanel, ws as never);
    const list = wrapper.find('[data-test="ws-env-readonly"]');
    expect(list.exists()).toBe(true);
    const text = list.text();
    expect(text).toContain('LOG_LEVEL');
    expect(text).toContain('info');
    expect(text).toContain('plain');
    // Secret: masked value + a "secret" type label, and NO warning el-tag.
    expect(text).toContain('API_TOKEN');
    expect(text).toContain('••••••••');
    expect(text).toContain('secret');
    expect(list.find('.el-tag').exists()).toBe(false);
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

  /**
   * Feature 032: the dependency release status is a CONFIGURATION VALUE, so it
   * follows the tab's convention (реш. 2026-07-13) — read-only in the
   * descriptions block, editable only inside the Edit modal. The ticket-scoping
   * switch stays inline because it is a standalone toggle, not a value.
   */
  it('General panel shows the dependency release status read-only, with no inline control', async () => {
    const wrapper = await mountPanel(GeneralPanel, {
      ...sampleWorkspace,
      dependency_release_status: 'In Review',
    });
    expect(wrapper.find('[data-test="config-dependency-release-status"]').text()).toBe('In Review');
    // No editable control outside the modal.
    expect(wrapper.find('[data-test="dependency-release-status"]').exists()).toBe(false);
  });

  it('General panel falls back to the default label when the status is unset', async () => {
    const wrapper = await mountPanel(GeneralPanel);
    expect(wrapper.find('[data-test="config-dependency-release-status"]').text()).toBe(
      'Done only (default)',
    );
  });

  it('General panel edit modal seeds and saves the dependency release status', async () => {
    let current: WorkspaceResponse = { ...sampleWorkspace, dependency_release_status: 'In Review' };
    let sent: { dependency_release_status?: string | null } | undefined;
    server.use(
      http.get('/api/workspaces/:id', () => HttpResponse.json(current)),
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        sent = (await request.json()) as { dependency_release_status?: string | null };
        current = {
          ...current,
          dependency_release_status: sent.dependency_release_status ?? null,
        };
        return HttpResponse.json(current);
      }),
    );
    const wrapper = mountWithProviders(GeneralPanel, { props: { id: sampleWorkspace.id } });
    active = wrapper;
    await flush();

    await openModal(wrapper, 'edit-config');
    // Seeds from the persisted response, inside the modal.
    expect(releaseSelect(wrapper).props('modelValue')).toBe('In Review');

    await releaseSelect(wrapper).setValue('QA');
    await flush();
    await clickBody('save-settings');
    await flush();
    await flush();

    expect(sent?.dependency_release_status).toBe('QA');
    expect(bodyQ('dependency-release-status')).toBeNull();
    expect(wrapper.find('[data-test="config-dependency-release-status"]').text()).toBe('QA');
  });

  it('clearing the status in the modal sends null (clear), not undefined (unchanged)', async () => {
    let current: WorkspaceResponse = { ...sampleWorkspace, dependency_release_status: 'In Review' };
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/workspaces/:id', () => HttpResponse.json(current)),
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        current = { ...current, dependency_release_status: null };
        return HttpResponse.json(current);
      }),
    );
    const wrapper = mountWithProviders(GeneralPanel, { props: { id: sampleWorkspace.id } });
    active = wrapper;
    await flush();

    await openModal(wrapper, 'edit-config');
    await releaseSelect(wrapper).setValue('');
    await flush();
    await clickBody('save-settings');
    await flush();
    await flush();

    // `undefined` would be read as "leave unchanged" by the merge-patch.
    expect(sent).toHaveProperty('dependency_release_status', null);
    expect(wrapper.find('[data-test="config-dependency-release-status"]').text()).toBe(
      'Done only (default)',
    );
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

  it('Environment panel: Add repository opens an empty create form with NO env editor', async () => {
    const wrapper = await mountPanel(EnvironmentPanel);
    await openModal(wrapper, 'add-repo');
    expect((bodyQ('repo-form-name') as HTMLInputElement).value).toBe('');
    // Env is edit-only now — creation collects only name/url/branch; no env
    // table, no bulk button, no "save first" hint.
    expect(bodyQ('repo-form-env')).toBeNull();
    expect(bodyQ('repo-bulk-env')).toBeNull();
    expect(bodyQ('repo-form-new-hint')).toBeNull();
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

  it('Environment panel: "Add from .env" seeds masked secrets and re-seals a changed one on apply', async () => {
    const ws = {
      ...sampleWorkspace,
      repositories: [
        { id: 'repo-api-1', name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main', env: { PORT: '3100' } },
      ],
      env_secret_keys: { workspace: [], repos: { 'repo-api-1': ['API_TOKEN'] }, agents: {} },
    };
    let secretBody: { scope?: unknown; set?: Record<string, string>; delete?: string[] } | undefined;
    server.use(
      http.put('/api/workspaces/:id/env-secrets', async ({ request }) => {
        secretBody = (await request.json()) as typeof secretBody;
        return HttpResponse.json({ ...ws });
      }),
    );

    const wrapper = await mountPanel(EnvironmentPanel, ws as never);
    await openModal(wrapper, 'edit-repo-0');
    await clickBody('repo-bulk-env'); // button lives inside the teleported repo modal
    // Seeded: plaintext value + masked secret.
    expect((bodyQ('bulk-env-textarea') as HTMLTextAreaElement).value).toBe(`PORT=3100\nAPI_TOKEN=${SECRET_MASK}`);

    // Change the plaintext and rotate the secret (mask replaced with a value).
    await setBodyInput('bulk-env-textarea', 'PORT=4000\nAPI_TOKEN=rotated');
    await clickBody('bulk-env-apply');
    await flush();
    await flush();

    // The changed secret was persisted via the env-secrets endpoint...
    expect(secretBody?.scope).toEqual({ repository_id: 'repo-api-1' });
    expect(secretBody?.set).toEqual({ API_TOKEN: 'rotated' });
    // ...and the plaintext change landed in the inline table.
    expect((bodyQ('env-plain-value-PORT') as HTMLInputElement).value).toBe('4000');
    // The repo modal stays open (only the nested bulk dialog dismissed).
    expect(bodyQ('repo-form-name')).not.toBeNull();
  });

  it('Environment panel: promoting a saved repo plain var seals it AFTER the settings PATCH', async () => {
    const ws = {
      ...sampleWorkspace,
      repositories: [
        { id: 'repo-api-1', name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main', env: { PORT: '3100', API_KEY: 'plainval' } },
      ],
      env_secret_keys: { workspace: [], repos: { 'repo-api-1': [] }, agents: {} },
    };
    const calls: string[] = [];
    let settingsBody: { repositories?: { env?: Record<string, string> }[] } | undefined;
    let secretBody: { scope?: unknown; set?: Record<string, string> } | undefined;
    server.use(
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        calls.push('settings');
        settingsBody = (await request.json()) as typeof settingsBody;
        return HttpResponse.json(ws);
      }),
      http.put('/api/workspaces/:id/env-secrets', async ({ request }) => {
        calls.push('secrets');
        secretBody = (await request.json()) as typeof secretBody;
        return HttpResponse.json({ ...ws, env_secret_keys: { workspace: [], repos: { 'repo-api-1': ['API_KEY'] }, agents: {} } });
      }),
    );

    const wrapper = await mountPanel(EnvironmentPanel, ws as never);
    await openModal(wrapper, 'edit-repo-0');
    await clickBody('env-plain-secret-API_KEY'); // promote (deferred)
    await clickBody('repo-save');
    await flush();
    await flush();

    // Ordering: plaintext drop FIRST, then the seal (the only order the guards allow).
    expect(calls).toEqual(['settings', 'secrets']);
    // API_KEY is gone from the plaintext PATCH; PORT stays.
    expect(settingsBody?.repositories?.[0].env).toEqual({ PORT: '3100' });
    // ...and it is sealed with its value under the repo scope.
    expect(secretBody?.scope).toEqual({ repository_id: 'repo-api-1' });
    expect(secretBody?.set).toEqual({ API_KEY: 'plainval' });
    expect(bodyQ('repo-form-name')).toBeNull(); // modal closed on success
  });

  it('Environment panel: promoting a workspace default seals it AFTER the settings PATCH', async () => {
    const ws = {
      ...sampleWorkspace,
      env: { LOG_LEVEL: 'info', DB_PASS: 'plainpass' },
      env_secret_keys: { workspace: [], repos: {}, agents: {} },
    };
    const calls: string[] = [];
    let settingsBody: { env?: Record<string, string> } | undefined;
    let secretBody: { scope?: unknown; set?: Record<string, string> } | undefined;
    server.use(
      http.put('/api/workspaces/:id/settings', async ({ request }) => {
        calls.push('settings');
        settingsBody = (await request.json()) as typeof settingsBody;
        return HttpResponse.json(ws);
      }),
      http.put('/api/workspaces/:id/env-secrets', async ({ request }) => {
        calls.push('secrets');
        secretBody = (await request.json()) as typeof secretBody;
        return HttpResponse.json({ ...ws, env_secret_keys: { workspace: ['DB_PASS'], repos: {}, agents: {} } });
      }),
    );

    const wrapper = await mountPanel(EnvironmentPanel, ws as never);
    await openModal(wrapper, 'edit-environment');
    await clickBody('env-plain-secret-DB_PASS');
    await clickBody('save-environment');
    await flush();
    await flush();

    expect(calls).toEqual(['settings', 'secrets']);
    expect(settingsBody?.env).toEqual({ LOG_LEVEL: 'info' });
    expect(secretBody?.scope).toEqual('workspace');
    expect(secretBody?.set).toEqual({ DB_PASS: 'plainpass' });
  });

  it('Environment panel: a failed seal keeps the repo modal open and is retry-safe', async () => {
    const ws = {
      ...sampleWorkspace,
      repositories: [
        { id: 'repo-api-1', name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main', env: { API_KEY: 'plainval' } },
      ],
      env_secret_keys: { workspace: [], repos: { 'repo-api-1': [] }, agents: {} },
    };
    let settingsCalls = 0;
    server.use(
      http.put('/api/workspaces/:id/settings', () => {
        settingsCalls += 1;
        return HttpResponse.json(ws);
      }),
      http.put('/api/workspaces/:id/env-secrets', () => HttpResponse.json({ message: 'boom' }, { status: 500 })),
    );

    const wrapper = await mountPanel(EnvironmentPanel, ws as never);
    await openModal(wrapper, 'edit-repo-0');
    await clickBody('env-plain-secret-API_KEY');
    await clickBody('repo-save');
    await flush();
    await flush();

    // Settings committed once; the seal failed → modal stays open with an error,
    // so the user can retry (value is still local, plaintext already dropped).
    expect(settingsCalls).toBe(1);
    expect(bodyQ('repo-form-name')).not.toBeNull();
    expect(bodyQ('repo-env-error')).not.toBeNull();
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

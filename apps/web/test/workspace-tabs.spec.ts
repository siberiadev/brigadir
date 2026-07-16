import { describe, it, expect } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { RouterLink, type Router } from 'vue-router';
import { mountWithProviders, flush } from './mount';
import { routes } from '../src/router';
import WorkspaceList from '../src/views/WorkspaceList.vue';
// Static imports warm the module cache so the router's lazy `() => import(...)`
// route components resolve from cache (deterministic navigation under jsdom).
import '../src/views/WorkspacePage.vue';
import '../src/views/AgentsList.vue';
import '../src/views/Runs.vue';
import '../src/views/WorkspaceSettings.vue';
import '../src/views/HumanQueue.vue';

/**
 * Feature 007 — Workspace Tabs Navigation. These component tests drive the app's
 * REAL routes (imported from `src/router`) through the memory-history harness, so
 * a regression in the router config (nesting, deep-link paths, settings
 * precedence) is caught here. `AgentsList`/`Runs` are reused as-is as the two tab
 * bodies (FR-011); `WorkspacePage` + `WorkspaceTabs` are the new shell.
 *
 * Element Plus component events (`el-tabs` `@tab-change`, `el-table` `@row-click`)
 * are driven via `$emit` — the same jsdom-safe convention the 006 `runs-table`
 * spec uses — because Element Plus's native tab/row click handlers don't fire
 * under jsdom. The `data-test` labels still render for real-browser interaction.
 */

// A minimal app root so the depth-0 <router-view> renders WorkspacePage and its
// own nested <router-view> renders the active tab body (Agents/Runs).
const AppRoot = { template: '<router-view />' };

/** Flush until `predicate` holds (route commit / async body mount), bounded. */
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await flush(5);
  await flush();
}

async function mountApp(initialPath: string) {
  const wrapper = mountWithProviders(AppRoot, { routes, initialPath });
  const router = wrapper.vm.$router;
  await router.isReady();
  await flush();
  return { wrapper, router };
}

/** Switch tab the way the user does — through the el-tabs `@tab-change` contract. */
async function switchTab(wrapper: VueWrapper, router: Router, name: string) {
  await wrapper.findComponent({ name: 'ElTabs' }).vm.$emit('tab-change', name);
  await settle(() => router.currentRoute.value.name === name);
}

describe('WorkspaceTabs — tab switching (US1)', () => {
  it('renders the Agents body under the tab strip and swaps to Runs and back (FR-007/FR-008)', async () => {
    const { wrapper, router } = await mountApp('/workspaces/ws-1/agents');

    expect(wrapper.find('[data-test="workspace-tabs"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="workspace-tab-agents"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="workspace-tab-runs"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(true);

    await switchTab(wrapper, router, 'runs');

    expect(
      wrapper.find('[data-test="runs-table"]').exists() ||
        wrapper.find('[data-test="runs-empty"]').exists(),
    ).toBe(true);
    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(false);
    expect(router.currentRoute.value.name).toBe('runs');
    expect(router.currentRoute.value.path).toBe('/workspaces/ws-1/runs');

    await switchTab(wrapper, router, 'agents');

    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(true);
    expect(router.currentRoute.value.name).toBe('agents');
  });
});

describe('WorkspaceTabs — deep-links & history (US2)', () => {
  it('resolves the shipped /runs deep-link to the Runs tab (FR-009)', async () => {
    const { wrapper, router } = await mountApp('/workspaces/ws-1/runs');

    expect(router.currentRoute.value.name).toBe('runs');
    expect(
      wrapper.find('[data-test="runs-table"]').exists() ||
        wrapper.find('[data-test="runs-empty"]').exists(),
    ).toBe(true);
    expect(wrapper.find('[data-test="workspace-tabs"]').exists()).toBe(true);
  });

  it('resolves the shipped /agents deep-link to the Agents tab (FR-009)', async () => {
    const { wrapper, router } = await mountApp('/workspaces/ws-1/agents');

    expect(router.currentRoute.value.name).toBe('agents');
    expect(wrapper.find('[data-test="agents-table"]').exists()).toBe(true);
  });

  it('browser back returns to the previous tab (FR-010)', async () => {
    const { wrapper, router } = await mountApp('/workspaces/ws-1/agents');

    await switchTab(wrapper, router, 'runs');
    expect(router.currentRoute.value.name).toBe('runs');

    router.back();
    await settle(() => router.currentRoute.value.name === 'agents');
    expect(router.currentRoute.value.name).toBe('agents');
  });
});

describe('WorkspaceTabs — unknown-tab fallback & settings precedence (US2)', () => {
  it('falls back to the Runs tab for an unrecognized tab address (FR-012, реш. 2026-07-15: Runs is the default)', async () => {
    const { router } = await mountApp('/workspaces/ws-1/agents');

    router.push('/workspaces/ws-1/bogus');
    await settle(() => router.currentRoute.value.name === 'runs' && router.currentRoute.value.path === '/workspaces/ws-1/runs');

    expect(router.currentRoute.value.name).toBe('runs');
    expect(router.currentRoute.value.path).toBe('/workspaces/ws-1/runs');
  });

  it('bare /workspaces/:id redirects to the Runs tab (default-active, реш. 2026-07-15)', async () => {
    const { router } = await mountApp('/workspaces/ws-1/agents');

    router.push('/workspaces/ws-1');
    await settle(() => router.currentRoute.value.name === 'runs');

    expect(router.currentRoute.value.path).toBe('/workspaces/ws-1/runs');
  });

  it('resolves /settings to the nested settings tab ahead of the catch-all (008/R1)', async () => {
    const { router } = await mountApp('/workspaces/ws-1/agents');

    // Feature 008 retired the standalone page: the deep-link now resolves to the
    // nested `settings` tab child, declared before `:catchAll` so it is not
    // swallowed by the unknown-tab redirect.
    expect(router.resolve('/workspaces/ws-1/settings').name).toBe('settings');
  });
});

describe('WorkspaceTabs — Human queue tab (workspace-scoped)', () => {
  it('renders the workspace-scoped Human queue body under the tab strip and swaps to it', async () => {
    const { wrapper, router } = await mountApp('/workspaces/ws-1/runs');

    // The tab appears in the strip.
    expect(wrapper.find('[data-test="workspace-tab-workspace-human-queue"]').exists()).toBe(true);

    await switchTab(wrapper, router, 'workspace-human-queue');

    expect(router.currentRoute.value.name).toBe('workspace-human-queue');
    expect(router.currentRoute.value.path).toBe('/workspaces/ws-1/human-queue');
    // The reused HumanQueue body mounts (Open/History filter present); the global
    // page <h2> is hidden in the scoped tab.
    expect(wrapper.find('[data-test="queue-filter"]').exists()).toBe(true);
    expect(wrapper.find('h2').exists()).toBe(false);
  });

  it('resolves the /human-queue deep-link to the nested workspace tab, not the global route', async () => {
    const { router } = await mountApp('/workspaces/ws-1/human-queue');

    expect(router.currentRoute.value.name).toBe('workspace-human-queue');
    expect(router.currentRoute.value.params.id).toBe('ws-1');
    // The standalone global queue keeps its own route.
    expect(router.resolve('/human-queue').name).toBe('human-queue');
  });
});

describe('WorkspaceList — row-click navigation (US1)', () => {
  it('opens the workspace on the Runs tab when a row body is clicked (FR-003, реш. 2026-07-15: Runs is the default)', async () => {
    const wrapper = mountWithProviders(WorkspaceList, { routes, initialPath: '/' });
    const router = wrapper.vm.$router;
    await router.isReady();
    await flush();

    await wrapper.findComponent({ name: 'ElTable' }).vm.$emit('row-click', { id: 'ws-1' });
    await settle(() => router.currentRoute.value.name === 'runs');

    expect(router.currentRoute.value.path).toBe('/workspaces/ws-1/runs');
    expect(router.currentRoute.value.name).toBe('runs');
  });
});

describe('WorkspaceList — list stays focused on lifecycle actions (US3)', () => {
  async function mountList() {
    const wrapper = mountWithProviders(WorkspaceList, { routes, initialPath: '/' });
    const router = wrapper.vm.$router;
    await router.isReady();
    await flush();
    return { wrapper, router };
  }

  it('shows no Agents/Runs buttons on a row (FR-001)', async () => {
    const { wrapper } = await mountList();

    // No RouterLink controls remain in the list rows…
    expect(wrapper.findAllComponents(RouterLink).length).toBe(0);
    // …and no button reads "Agents" or "Runs".
    const buttonTexts = wrapper.findAll('button').map((b) => b.text());
    expect(buttonTexts).not.toContain('Agents');
    expect(buttonTexts).not.toContain('Runs');
    // The retained lifecycle actions are still present.
    expect(buttonTexts.some((t) => t === 'Pause' || t === 'Start')).toBe(true);
    expect(wrapper.find('[data-test="open-settings-ws-1"]').exists()).toBe(true);
  });

  it('activating Start/Pause does not navigate into the workspace (FR-004)', async () => {
    const { wrapper, router } = await mountList();

    await wrapper.find('[data-test="toggle-pause-ws-1"]').trigger('click');
    await flush();

    expect(router.currentRoute.value.name).not.toBe('agents');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('clicking Settings navigates to the settings tab, not the agents tab (008)', async () => {
    const { wrapper, router } = await mountList();

    await wrapper.find('[data-test="open-settings-ws-1"]').trigger('click');
    await settle(() => router.currentRoute.value.name === 'settings');

    expect(router.currentRoute.value.name).toBe('settings');
    expect(router.currentRoute.value.name).not.toBe('agents');
  });
});

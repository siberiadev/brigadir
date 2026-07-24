import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// All routes render inside App.vue's token gate (the shared dashboard bearer),
// so the whole surface is behind the existing auth flow (FR-032) — no per-route
// guard needed. Runs are workspace-scoped; the run card is addressed by run id.
export const routes: RouteRecordRaw[] = [
  // Feature 017: /home is the landing page; the root redirects so old `/`
  // bookmarks keep working. The workspace list moved to /workspaces and KEEPS
  // its route name — every router.push({ name: 'workspaces' }) resolves as-is.
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: () => import('../views/HomeDashboard.vue') },
  { path: '/workspaces', name: 'workspaces', component: () => import('../views/WorkspaceList.vue') },
  {
    // Workspace page: a shell with three router-driven tabs (Runs | Agents |
    // Settings). The shipped deep-links `/workspaces/:id/agents`,
    // `/workspaces/:id/runs`, and `/workspaces/:id/settings` stay VERBATIM as
    // nested children (FR-009/FR-010), so every existing link resolves unchanged
    // (settings now lands on the tab). Empty path redirects to Runs — the
    // default-active tab (реш. 2026-07-15; supersedes FR-006's Agents default).
    path: '/workspaces/:id',
    component: () => import('../views/WorkspacePage.vue'),
    props: true,
    children: [
      {
        path: '',
        name: 'workspace',
        redirect: (to) => ({ name: 'runs', params: { id: to.params.id } }),
      },
      {
        path: 'agents',
        name: 'agents',
        component: () => import('../views/AgentsList.vue'),
        props: true,
      },
      {
        path: 'runs',
        name: 'runs',
        component: () => import('../views/Runs.vue'),
        props: true,
      },
      {
        // Workspace-scoped Human queue tab. Reuses the global HumanQueue.vue,
        // passing the route `:id` as its `workspaceId` prop so the queue is
        // filtered to this workspace. Distinct route name from the global
        // `human-queue` (line ~61). Declared before `:catchAll`.
        path: 'human-queue',
        name: 'workspace-human-queue',
        component: () => import('../views/HumanQueue.vue'),
        props: (to) => ({ workspaceId: to.params.id }),
      },
      {
        // Feature 022 (US3): blocked-waiting tickets of the workspace.
        path: 'waiting',
        name: 'waiting',
        component: () => import('../views/WorkspaceWaiting.vue'),
        props: true,
      },
      {
        // Feature 008 (US3): the standalone settings page is retired — settings
        // is a nested tab child. Feature 031: settings itself became a shell
        // with a left sub-nav + its own nested children (General / Jira /
        // Environment / Agents). The empty child keeps the `settings` route name
        // (deep-links + the top tab strip) and redirects to General. Every child
        // carries `meta.tab: 'settings'` so the top-level WorkspaceTabs highlights
        // the Settings tab on any sub-route. Declared BEFORE `:catchAll`.
        path: 'settings',
        component: () => import('../views/WorkspaceSettings.vue'),
        props: true,
        children: [
          {
            path: '',
            name: 'settings',
            redirect: (to) => ({ name: 'settings-general', params: { id: to.params.id } }),
          },
          {
            path: 'general',
            name: 'settings-general',
            component: () => import('../views/workspace-settings/GeneralPanel.vue'),
            props: true,
            meta: { tab: 'settings' },
          },
          {
            path: 'jira',
            name: 'settings-jira',
            component: () => import('../views/workspace-settings/JiraPanel.vue'),
            props: true,
            meta: { tab: 'settings' },
          },
          {
            path: 'environment',
            name: 'settings-environment',
            component: () => import('../views/workspace-settings/EnvironmentPanel.vue'),
            props: true,
            meta: { tab: 'settings' },
          },
          {
            path: 'agents',
            name: 'settings-agents',
            component: () => import('../views/workspace-settings/AgentsPanel.vue'),
            props: true,
            meta: { tab: 'settings' },
          },
        ],
      },
      {
        // Unknown tab → fall back to Runs, the default tab (реш. 2026-07-15;
        // supersedes FR-012's Agents fallback). Declared LAST so the named
        // `settings`/`agents`/`runs` children out-rank this wildcard.
        path: ':catchAll(.*)*',
        redirect: (to) => ({ name: 'runs', params: { id: to.params.id } }),
      },
    ],
  },
  {
    path: '/runs/:id',
    name: 'run-card',
    component: () => import('../views/RunCard.vue'),
    props: true,
  },
  { path: '/human-queue', name: 'human-queue', component: () => import('../views/HumanQueue.vue') },
  // Feature 029: read-only metrics timeline dashboard.
  { path: '/metrics', name: 'metrics', component: () => import('../views/MetricsPage.vue') },
  {
    // Platform Settings (2026-07-13): a shell with its own left sub-navigation;
    // panels are nested children so future sections (Users, Usage) are one
    // child route each. Bare /settings lands on General.
    path: '/settings',
    component: () => import('../views/settings/PlatformSettings.vue'),
    children: [
      { path: '', name: 'platform-settings', redirect: '/settings/general' },
      {
        path: 'general',
        name: 'platform-settings-general',
        component: () => import('../views/settings/SettingsGeneral.vue'),
      },
      {
        // feature 015: the default-orchestrator template + both brigadir
        // instruction texts (relocated from General).
        path: 'brigadir-agent',
        name: 'platform-settings-brigadir-agent',
        component: () => import('../views/settings/SettingsBrigadirAgent.vue'),
      },
      {
        path: 'executors',
        name: 'platform-settings-executors',
        component: () => import('../views/settings/SettingsExecutors.vue'),
      },
    ],
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

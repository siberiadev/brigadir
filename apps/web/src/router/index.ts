import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// All routes render inside App.vue's token gate (the shared dashboard bearer),
// so the whole surface is behind the existing auth flow (FR-032) — no per-route
// guard needed. Runs are workspace-scoped; the run card is addressed by run id.
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'workspaces', component: () => import('../views/WorkspaceList.vue') },
  {
    // Workspace page: a shell with three router-driven tabs (Agents | Runs |
    // Settings). The shipped deep-links `/workspaces/:id/agents`,
    // `/workspaces/:id/runs`, and `/workspaces/:id/settings` stay VERBATIM as
    // nested children (FR-009/FR-010), so every existing link resolves unchanged
    // (settings now lands on the tab). Empty path redirects to Agents (FR-006).
    path: '/workspaces/:id',
    component: () => import('../views/WorkspacePage.vue'),
    props: true,
    children: [
      {
        path: '',
        name: 'workspace',
        redirect: (to) => ({ name: 'agents', params: { id: to.params.id } }),
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
        // Feature 008 (US3): the standalone settings page is retired — settings
        // is now a nested tab child. Declared BEFORE `:catchAll` so the
        // `/workspaces/:id/settings` deep-link resolves to this tab and is not
        // swallowed by the unknown-tab redirect (guarded by a test — R1 risk).
        path: 'settings',
        name: 'settings',
        component: () => import('../views/WorkspaceSettings.vue'),
        props: true,
      },
      {
        // Unknown tab → fall back to Agents (FR-012). Declared LAST so the named
        // `settings`/`agents`/`runs` children out-rank this wildcard.
        path: ':catchAll(.*)*',
        redirect: (to) => ({ name: 'agents', params: { id: to.params.id } }),
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
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

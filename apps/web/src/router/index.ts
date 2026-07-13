import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// All routes render inside App.vue's token gate (the shared dashboard bearer),
// so the whole surface is behind the existing auth flow (FR-032) — no per-route
// guard needed. Runs are workspace-scoped; the run card is addressed by run id.
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'workspaces', component: () => import('../views/WorkspaceList.vue') },
  {
    // Workspace page: a shell with two router-driven tabs (Agents | Runs). The
    // shipped deep-links `/workspaces/:id/agents` and `/workspaces/:id/runs`
    // stay VERBATIM as nested children (FR-009), so every existing link resolves
    // unchanged. Empty path redirects to the default Agents tab (FR-006).
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
        // Unknown tab → fall back to Agents (FR-012). The top-level static
        // `/workspaces/:id/settings` out-ranks this nested wildcard, so settings
        // is not swallowed (guarded by a test — R1 risk).
        path: ':catchAll(.*)*',
        redirect: (to) => ({ name: 'agents', params: { id: to.params.id } }),
      },
    ],
  },
  {
    // Kept top-level (NOT a tab). Its static `settings` segment out-ranks the
    // nested unknown-tab `:catchAll` redirect, so `/settings` still resolves to
    // `workspace-settings` (guarded by a test — R1 risk).
    path: '/workspaces/:id/settings',
    name: 'workspace-settings',
    component: () => import('../views/WorkspaceSettings.vue'),
    props: true,
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

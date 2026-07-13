import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// All routes render inside App.vue's token gate (the shared dashboard bearer),
// so the whole surface is behind the existing auth flow (FR-032) — no per-route
// guard needed. Runs are workspace-scoped; the run card is addressed by run id.
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'workspaces', component: () => import('../views/WorkspaceList.vue') },
  {
    path: '/workspaces/:id/agents',
    name: 'agents',
    component: () => import('../views/AgentsList.vue'),
    props: true,
  },
  {
    path: '/workspaces/:id/runs',
    name: 'runs',
    component: () => import('../views/Runs.vue'),
    props: true,
  },
  {
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

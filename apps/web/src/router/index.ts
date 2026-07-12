import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'workspaces', component: () => import('../views/WorkspaceList.vue') },
  {
    path: '/workspaces/:id/agents',
    name: 'agents',
    component: () => import('../views/AgentsList.vue'),
    props: true,
  },
  // Iteration-6 placeholders (Runs + human queue live behind these routes).
  { path: '/runs', name: 'runs', component: () => import('../views/Runs.vue') },
  { path: '/human-queue', name: 'human-queue', component: () => import('../views/HumanQueue.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

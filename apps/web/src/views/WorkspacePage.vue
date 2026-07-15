<script setup lang="ts">
import BackLink from '../components/BackLink.vue';
import WorkspaceHeader from '../components/WorkspaceHeader/WorkspaceHeader.vue';
import WorkspaceTabs from '../components/WorkspaceTabs/WorkspaceTabs.vue';

/**
 * Parent tab page for a workspace. Renders the shared workspace title + tab
 * strip and the nested <router-view> that swaps between the Agents, Runs, and
 * Settings bodies (FR-007). The workspace name lives here (WorkspaceHeader), so
 * the bodies no longer repeat it in their own heading.
 */
defineProps<{ id: string }>();

// Runs first and default-active (реш. 2026-07-15) — the day-to-day surface;
// Agents/Settings are setup surfaces.
const tabs = [
  { name: 'runs', label: 'Runs' },
  { name: 'agents', label: 'Agents' },
  { name: 'settings', label: 'Settings' },
];
</script>

<template>
  <section>
    <BackLink to="/" label="Workspaces" class="back" />
    <WorkspaceHeader :id="id" />
    <WorkspaceTabs :id="id" :tabs="tabs" />
    <router-view />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.back {
  margin-bottom: $space-sm;
}
</style>

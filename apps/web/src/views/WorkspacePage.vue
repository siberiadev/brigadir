<script setup lang="ts">
import WorkspaceTabs from '../components/WorkspaceTabs/WorkspaceTabs.vue';

/**
 * Parent tab page for a workspace. Renders the shared tab strip and the nested
 * <router-view> that swaps between the Agents, Runs, and Settings bodies
 * (FR-007). No workspace-name heading here — the list bodies already render one
 * (FR-011).
 */
defineProps<{ id: string }>();

const tabs = [
  { name: 'agents', label: 'Agents' },
  { name: 'runs', label: 'Runs' },
  { name: 'settings', label: 'Settings' },
];
</script>

<template>
  <section>
    <WorkspaceTabs :id="id" :tabs="tabs" />
    <router-view />
  </section>
</template>

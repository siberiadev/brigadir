<script setup lang="ts">
import { useRoute, RouterLink, RouterView } from 'vue-router';

/**
 * Workspace Settings shell (feature 031 restructure). A page-local left
 * sub-navigation + the active panel rendered by the nested RouterView, mirroring
 * the platform Settings shell (PlatformSettings.vue). Sections: General, Jira
 * connection, Environment, Agents (the agent role-template source). Each is one
 * nav entry + one child route.
 */
const props = defineProps<{ id: string }>();

type NavItem = { key: string; label: string; to: { name: string; params: { id: string } } };
const navItems: NavItem[] = [
  { key: 'general', label: 'General', to: { name: 'settings-general', params: { id: props.id } } },
  { key: 'jira', label: 'Jira connection', to: { name: 'settings-jira', params: { id: props.id } } },
  { key: 'environment', label: 'Environment', to: { name: 'settings-environment', params: { id: props.id } } },
  { key: 'agents', label: 'Agents', to: { name: 'settings-agents', params: { id: props.id } } },
];

const route = useRoute();
</script>

<template>
  <div class="workspace-settings">
    <nav class="settings-subnav" data-test="workspace-settings-subnav">
      <RouterLink
        v-for="item in navItems"
        :key="item.key"
        :to="item.to"
        class="subnav-item"
        :class="{ 'is-active': route.name === `settings-${item.key}` }"
        :data-test="`workspace-settings-nav-${item.key}`"
      >
        {{ item.label }}
      </RouterLink>
    </nav>
    <section class="settings-panel">
      <RouterView />
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workspace-settings {
  display: flex;
  gap: $space-lg;
  align-items: flex-start;
}
.settings-subnav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
}
.subnav-item {
  padding: 8px 12px;
  border-radius: $radius-md;
  color: var(--el-text-color-regular);
  text-decoration: none;

  &:hover {
    background: var(--el-fill-color-light);
    color: var(--el-text-color-primary);
  }
  &.is-active {
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
    font-weight: 600;
  }
}
.settings-panel {
  flex: 1;
  min-width: 0;
  max-width: 720px;
}
</style>

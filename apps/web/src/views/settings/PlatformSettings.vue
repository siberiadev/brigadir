<script setup lang="ts">
import { useRoute, RouterLink, RouterView } from 'vue-router';

/**
 * Platform Settings shell (2026-07-13): a page-local left SUB-navigation inside
 * the content area, with the active panel rendered by the nested RouterView.
 * The item list is data — adding a future section (General, Users, Usage) is
 * one entry + one child route, nothing else.
 */
type SettingsNavItem = { key: string; label: string; to: string };

const navItems: SettingsNavItem[] = [
  { key: 'general', label: 'General', to: '/settings/general' },
  { key: 'executors', label: 'Executors', to: '/settings/executors' },
  // Future: Users, Usage…
];

const route = useRoute();
</script>

<template>
  <div class="platform-settings">
    <h2 class="settings-title">Settings</h2>
    <div class="settings-body">
      <nav class="settings-subnav" data-test="settings-subnav">
        <RouterLink
          v-for="item in navItems"
          :key="item.key"
          :to="item.to"
          class="subnav-item"
          :class="{ 'is-active': route.path.startsWith(item.to) }"
          :data-test="`settings-nav-${item.key}`"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
      <section class="settings-panel">
        <RouterView />
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-title {
  margin: 0 0 $space-lg;
}
.settings-body {
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
}
</style>

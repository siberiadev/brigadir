<script setup lang="ts">
import type { Component } from 'vue';
import { useRoute, type RouteLocationRaw } from 'vue-router';
import { LayoutGrid, Inbox, LogOut, Settings } from 'lucide-vue-next';

/**
 * Icon rail (feature 009). PURE presentational: it takes the open-human-task
 * count as a prop and emits `sign-out` — no store access and no count query
 * inside. `App.vue` owns the count query + the 006 landing watch and passes
 * `openCount` down; sign-out flows up as an emit (contracts/app-sidebar.md).
 */
defineProps<{ openCount: number }>();
const emit = defineEmits<{ (e: 'sign-out'): void }>();

// Static, two-item nav config (data-model.md NavItem). `LogOut` is imported for
// the bottom-pinned sign-out control rendered below the nav.
type NavItem = {
  key: 'workspaces' | 'human-queue';
  label: string;
  icon: Component;
  to: RouteLocationRaw;
  isActive: (path: string) => boolean;
};

const navItems: NavItem[] = [
  {
    key: 'workspaces',
    label: 'Workspaces',
    icon: LayoutGrid,
    to: '/',
    // Root plus every nested workspace sub-route (agents/runs/settings) — a path
    // prefix test covers the 007 deep-links without enumerating child names (R3).
    isActive: (path) => path === '/' || path.startsWith('/workspaces'),
  },
  {
    key: 'human-queue',
    label: 'Human queue',
    icon: Inbox,
    to: '/human-queue',
    isActive: (path) => path === '/human-queue',
  },
];

// Active state derives from the live route path; unmatched routes (e.g.
// `/runs/:id`) highlight nothing (FR-006/FR-007, data-model `isActive`).
const route = useRoute();
</script>

<template>
  <aside class="app-sidebar" data-test="app-sidebar">
    <div class="sidebar-brand" data-test="sidebar-brand">B</div>
    <nav class="sidebar-nav">
      <el-tooltip
        v-for="item in navItems"
        :key="item.key"
        :content="item.label"
        placement="right"
      >
        <RouterLink
          :to="item.to"
          class="nav-item"
          :class="{ 'is-active': item.isActive(route.path) }"
          :data-test="`nav-${item.key}`"
        >
          <el-badge
            v-if="item.key === 'human-queue'"
            data-test="queue-badge"
            :value="openCount"
            :max="99"
            :hidden="openCount === 0"
            type="danger"
          >
            <component :is="item.icon" class="nav-icon" />
          </el-badge>
          <component v-else :is="item.icon" class="nav-icon" />
        </RouterLink>
      </el-tooltip>
    </nav>
    <div class="sidebar-bottom">
      <!-- Platform Settings (2026-07-13): pinned above Sign out, active for /settings/*. -->
      <el-tooltip content="Settings" placement="right">
        <RouterLink
          to="/settings"
          class="nav-item"
          :class="{ 'is-active': route.path.startsWith('/settings') }"
          data-test="nav-settings"
        >
          <Settings class="nav-icon" />
        </RouterLink>
      </el-tooltip>
      <el-tooltip content="Sign out" placement="right">
        <button
          type="button"
          class="nav-item sign-out"
          data-test="sidebar-sign-out"
          @click="emit('sign-out')"
        >
          <LogOut class="nav-icon" />
        </button>
      </el-tooltip>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  width: 70px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-md 0;
  border-right: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.sidebar-brand {
  font-weight: $font-weight-bold;
  font-size: 22px;
  margin-bottom: $space-lg;
}
.sidebar-nav {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-md;
  flex: 1;
}
.sidebar-bottom {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-md;
}
// Shared icon-button chrome for nav links + the sign-out control.
.nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: $radius-md;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--el-fill-color-light);
    color: var(--el-text-color-primary);
  }
  &.is-active {
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
  }
}
.sign-out {
  border: none;
  background: transparent;
}
.nav-icon {
  width: 22px;
  height: 22px;
}
</style>

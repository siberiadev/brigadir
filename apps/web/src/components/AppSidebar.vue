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

// --- Animated icons (2026-07-14) ---------------------------------------------
// Hover animations in the lucide-animated.com style, hand-rolled as pure CSS on
// the existing lucide-vue-next SVGs: the Vue port of that library covers only
// 2 of our 4 glyphs and would add a motion dependency for four icons. SVG
// sub-element transforms require transform-box: fill-box + a center origin.
.nav-item :deep(svg *) {
  transform-box: fill-box;
  transform-origin: center;
}

// Workspaces: the four grid tiles pop in a quick stagger.
@keyframes tile-pop {
  0% { transform: scale(1); }
  40% { transform: scale(0.55); }
  100% { transform: scale(1); }
}
[data-test='nav-workspaces']:hover :deep(rect) {
  animation: tile-pop 0.45s ease both;
}
[data-test='nav-workspaces']:hover :deep(rect:nth-of-type(2)) { animation-delay: 0.07s; }
[data-test='nav-workspaces']:hover :deep(rect:nth-of-type(3)) { animation-delay: 0.14s; }
[data-test='nav-workspaces']:hover :deep(rect:nth-of-type(4)) { animation-delay: 0.21s; }

// Human queue: the inbox dips down to "receive" an item.
@keyframes inbox-dip {
  0% { transform: translateY(0); }
  45% { transform: translateY(2.5px); }
  100% { transform: translateY(0); }
}
[data-test='nav-human-queue']:hover :deep(svg.nav-icon) {
  animation: inbox-dip 0.4s ease;
}

// Settings: the gear turns while hovered and turns back on leave.
[data-test='nav-settings'] :deep(svg.nav-icon) {
  transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
}
[data-test='nav-settings']:hover :deep(svg.nav-icon) {
  transform: rotate(120deg);
}

// Sign out: the arrow slides out of the door. Current lucide LogOut renders
// three <path>s: arrowhead, shaft, door frame (in that order) — the first two
// are the arrow (verified against the live DOM; no polyline/line anymore).
[data-test='sidebar-sign-out'] :deep(path:nth-of-type(1)),
[data-test='sidebar-sign-out'] :deep(path:nth-of-type(2)) {
  transition: transform 0.25s ease;
}
[data-test='sidebar-sign-out']:hover :deep(path:nth-of-type(1)),
[data-test='sidebar-sign-out']:hover :deep(path:nth-of-type(2)) {
  transform: translateX(2.5px);
}

@media (prefers-reduced-motion: reduce) {
  .nav-item :deep(svg),
  .nav-item :deep(svg *) {
    animation: none !important;
    transition: none !important;
  }
}
</style>

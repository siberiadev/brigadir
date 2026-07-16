<script setup lang="ts">
import type { Component } from 'vue';
import { useRoute, type RouteLocationRaw } from 'vue-router';
import { LayoutGrid, Inbox, LogOut, Settings } from 'lucide-vue-next';
import AnimatedIcon from './AnimatedIcon.vue';

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
    <!-- Brand mark: dark `>_` on the amber badge (same art as /favicon.svg).
         Not a nav item — stays static per the sidebar animation convention. -->
    <div class="sidebar-brand" data-test="sidebar-brand" role="img" aria-label="BRIGADIR">
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="var(--el-color-primary)" />
        <path
          d="M17 20 L31 32 L17 44"
          fill="none"
          stroke="#1e293b"
          stroke-width="7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="M37 46 h12" fill="none" stroke="#1e293b" stroke-width="7" stroke-linecap="round" />
      </svg>
    </div>
    <nav class="sidebar-nav">
      <el-tooltip
        v-for="item in navItems"
        :key="item.key"
        :content="item.label"
        placement="right"
      >
        <RouterLink
          :to="item.to"
          class="nav-item anim-trigger"
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
            <AnimatedIcon effect="dip">
              <component :is="item.icon" class="nav-icon" />
            </AnimatedIcon>
          </el-badge>
          <!-- Workspaces keeps a bespoke per-part animation (tiles pop in a
               stagger) — see the CSS below and the AnimatedIcon two-tier note. -->
          <component v-else :is="item.icon" class="nav-icon" />
        </RouterLink>
      </el-tooltip>
    </nav>
    <div class="sidebar-bottom">
      <!-- Platform Settings (2026-07-13): pinned above Sign out, active for /settings/*. -->
      <el-tooltip content="Settings" placement="right">
        <RouterLink
          to="/settings"
          class="nav-item anim-trigger"
          :class="{ 'is-active': route.path.startsWith('/settings') }"
          data-test="nav-settings"
        >
          <AnimatedIcon effect="spin">
            <Settings class="nav-icon" />
          </AnimatedIcon>
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
  margin-bottom: $space-lg;

  svg {
    display: block;
    width: 38px;
    height: 38px;
  }
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
// Two-tier convention (CLAUDE.md "UI-конвенции"): whole-icon effects ride the
// AnimatedIcon wrapper (Inbox dip, Settings spin — the nav items carry
// `anim-trigger`); PER-PART effects below are bespoke by nature — they depend
// on each glyph's SVG anatomy. SVG sub-element transforms require
// transform-box: fill-box + a center origin.
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

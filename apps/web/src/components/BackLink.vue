<script setup lang="ts">
/**
 * "< Back" navigation for detail pages that display a single item of a list —
 * deep-links back to the owning list (deterministic, unlike history.back():
 * works for pages opened directly by URL / in a new tab).
 *
 * The arrow is STATIC — hover icon animation is sidebar-only (CLAUDE.md
 * "UI-конвенции", реш. 2026-07-15); hover feedback here is color only.
 */
import type { RouteLocationRaw } from 'vue-router';
import { ArrowLeft } from 'lucide-vue-next';

withDefaults(defineProps<{ to: RouteLocationRaw; label?: string }>(), { label: 'Back' });
</script>

<template>
  <router-link :to="to" class="back-link" data-test="back-link">
    <ArrowLeft :size="14" />
    <span>{{ label }}</span>
  </router-link>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.back-link {
  display: inline-flex;
  align-items: center;
  gap: $space-xs;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-decoration: none;

  &:hover {
    color: var(--el-color-primary);
  }
}
</style>

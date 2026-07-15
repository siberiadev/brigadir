<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspace } from '../../composables/useWorkspaces';

/**
 * Shared workspace title for the tab shell. Rendered once in WorkspacePage
 * (like WorkspaceTabs), so the current workspace name shows identically above
 * the Agents, Runs, and Settings bodies. Falls back to the id until the
 * workspace query resolves. Detail-запрос, не поиск по пагинированному списку
 * (UI-конвенция 2026-07-15).
 */
const props = defineProps<{ id: string }>();

const workspaceQuery = useWorkspace(props.id);
const name = computed(() => workspaceQuery.data.value?.name ?? props.id);
</script>

<template>
  <h1 class="workspace-name" data-test="workspace-name">{{ name }}</h1>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workspace-name {
  margin: 0 0 $space-sm;
  font-weight: $font-weight-bold;
  font-size: 20px;
  color: var(--el-text-color-primary);
}
</style>

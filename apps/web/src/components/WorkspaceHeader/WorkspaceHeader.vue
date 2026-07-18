<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspace, useSetWorkspaceEnabled } from '../../composables/useWorkspaces';

/**
 * Shared workspace title for the tab shell. Rendered once in WorkspacePage
 * (like WorkspaceTabs), so the current workspace name shows identically above
 * the Agents, Runs, and Settings bodies. Falls back to the id until the
 * workspace query resolves. Detail-запрос, не поиск по пагинированному списку
 * (UI-конвенция 2026-07-15).
 *
 * Также несёт Start/Pause — тот же переключатель `settings.enabled`, что и
 * инлайн-действие в WorkspaceList (US5): раньше остановить прогон можно было
 * только вернувшись в список. Инвалидация — внутри мутации, здесь её не дублируем.
 */
const props = defineProps<{ id: string }>();

const workspaceQuery = useWorkspace(props.id);
const name = computed(() => workspaceQuery.data.value?.name ?? props.id);
const enabled = computed(() => workspaceQuery.data.value?.enabled ?? false);
// Пока воркспейс не загружен, `enabled` — это дефолт, а не факт: не показываем
// ни статус, ни кнопку, чтобы не мигнуть чужой подписью («Start» на running).
const loaded = computed(() => workspaceQuery.data.value !== undefined);

const setEnabled = useSetWorkspaceEnabled();
const pending = ref(false);
async function togglePause() {
  const next = !enabled.value;
  pending.value = true;
  try {
    await setEnabled.mutateAsync({ workspaceId: props.id, enabled: next });
    ElMessage.success(next ? 'Workspace started.' : 'Workspace paused.');
  } catch (err) {
    ElMessage.error((err as Error)?.message ?? 'Could not update the pause state.');
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="workspace-header">
    <h1 class="workspace-name" data-test="workspace-name">{{ name }}</h1>
    <template v-if="loaded">
      <el-tag :type="enabled ? 'success' : 'info'" data-test="workspace-header-status">
        {{ enabled ? 'Running' : 'Paused' }}
      </el-tag>
      <el-button
        class="toggle"
        plain
        :type="enabled ? 'warning' : 'success'"
        :loading="pending"
        data-test="workspace-header-toggle-pause"
        @click="togglePause()"
      >
        {{ enabled ? 'Pause' : 'Start' }}
      </el-button>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workspace-header {
  display: flex;
  align-items: center;
  gap: $space-sm;
  margin: 0 0 $space-sm;
}

.workspace-name {
  margin: 0;
  font-weight: $font-weight-bold;
  font-size: 20px;
  color: var(--el-text-color-primary);
}

/* Действие прижато к правому краю — заголовок слева, статус рядом с ним. */
.toggle {
  margin-left: auto;
}
</style>

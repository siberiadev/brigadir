<script setup lang="ts">
import { computed } from 'vue';
import type { RunCostPeriod } from '@brigadir/contracts';
import { MAX_PAGE_SIZE } from '@brigadir/contracts/pagination';
import { useWorkspaces } from '../../composables/useWorkspaces';
import { useExecutors } from '../../composables/useExecutors';

/**
 * Shared top-of-page filters for /metrics (feature 029): period preset +
 * workspace picker + executor-type picker, applied to every tab. `period` is
 * always present; workspace/executor are clearable ("all").
 *
 * On the Human-in-the-loop tab the executor picker is disabled with an
 * explanatory tooltip — `executor_type` is not applicable to human-task metrics
 * (H1/FR-011a). The parent still owns the value; disabling only blocks editing.
 */
const props = withDefaults(
  defineProps<{
    /** False on the Human tab — disables the executor picker (H1/FR-011a). */
    executorApplicable?: boolean;
  }>(),
  { executorApplicable: true },
);

const period = defineModel<RunCostPeriod>('period', { required: true });
const workspaceId = defineModel<string | undefined>('workspaceId', { default: undefined });
const executorType = defineModel<string | undefined>('executorType', { default: undefined });

// Whole-list consumers do NOT paginate (UI convention 2026-07-15).
const workspacesQuery = useWorkspaces({ page: 1, page_size: MAX_PAGE_SIZE });
const executorsQuery = useExecutors({ page: 1, page_size: MAX_PAGE_SIZE });

// The filter value is the executor TYPE (mock/claude_cli/kimi/deepseek_api);
// many executor rows can share a type, so offer the distinct set.
const executorTypes = computed(() => {
  const types = new Set((executorsQuery.data.value?.items ?? []).map((e) => e.type));
  return [...types];
});
</script>

<template>
  <div class="metrics-filters" data-test="metrics-filters">
    <el-select
      v-model="workspaceId"
      clearable
      placeholder="Все воркспейсы"
      data-test="filter-workspace"
      class="filter-control"
    >
      <el-option
        v-for="ws in workspacesQuery.data.value?.items ?? []"
        :key="ws.id"
        :label="ws.name"
        :value="ws.id"
      />
    </el-select>

    <el-tooltip
      :disabled="props.executorApplicable"
      content="Неприменимо к задачам на людях"
      placement="top"
    >
      <el-select
        v-model="executorType"
        clearable
        :disabled="!props.executorApplicable"
        placeholder="Все исполнители"
        data-test="filter-executor"
        class="filter-control"
      >
        <el-option v-for="t in executorTypes" :key="t" :label="t" :value="t" />
      </el-select>
    </el-tooltip>

    <el-radio-group v-model="period" size="small" data-test="filter-period" class="period-switch">
      <el-radio-button label="24h" value="24h">24h</el-radio-button>
      <el-radio-button label="7d" value="7d">7d</el-radio-button>
      <el-radio-button label="30d" value="30d">30d</el-radio-button>
    </el-radio-group>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-filters {
  display: flex;
  align-items: center;
  gap: $space-md;
  margin: $space-lg 0;
}
.filter-control {
  width: 220px;
}
.period-switch {
  margin-left: auto;
}
</style>

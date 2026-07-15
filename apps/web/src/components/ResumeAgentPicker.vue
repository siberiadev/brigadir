<script setup lang="ts">
import { computed, watch } from 'vue';
import type { AgentResponse } from '@brigadir/contracts';
import { useAgents } from '../composables/useAgents';

/**
 * Agent picker for the Human Queue blocking-resume panel (feature 010, FR-017).
 * Lists the task workspace's ENABLED, NON-orchestrator agents; the original
 * agent is preselected. Its own query per instance keeps the cross-workspace
 * queue simple (each task loads its own workspace's roster).
 */
const props = defineProps<{
  workspaceId: string;
  originalAgentId: string | null;
  taskId: string;
}>();

const model = defineModel<string | undefined>({ required: true });

const query = useAgents(props.workspaceId, { page_size: 100 });

const agents = computed<AgentResponse[]>(() =>
  (query.data.value?.items ?? []).filter((a) => a.enabled && !a.is_orchestrator),
);

// Preselect the original agent once the roster is available (if still eligible).
watch(
  agents,
  (list) => {
    if (model.value) return;
    const preferred = props.originalAgentId && list.some((a) => a.id === props.originalAgentId)
      ? props.originalAgentId
      : list[0]?.id;
    if (preferred) model.value = preferred;
  },
  { immediate: true },
);
</script>

<template>
  <el-select
    v-model="model"
    class="agent-picker"
    :loading="query.isLoading.value"
    placeholder="Resume as…"
    :data-test="`resume-agent-${taskId}`"
  >
    <el-option v-for="a in agents" :key="a.id" :label="a.name" :value="a.id" />
  </el-select>
</template>

<style scoped lang="scss">
.agent-picker {
  min-width: 180px;
}
</style>

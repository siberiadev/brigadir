<script setup lang="ts">
import { computed, watch } from 'vue';
import type { AgentResponse } from '@brigadir/contracts';
import { useAgents } from '../composables/useAgents';

/**
 * Agent picker for the Human Queue blocking-resume panel (feature 010, FR-017 +
 * answer-triage delta). Lists the task workspace's ENABLED agents INCLUDING the
 * orchestrator, which is preselected by default: resolving to it hands the
 * answer to brigadir for triage (answer-triage run) instead of resuming a
 * worker directly. The human can still pick any worker — then the direct
 * resume behavior applies unchanged. Its own query per instance keeps the
 * cross-workspace queue simple (each task loads its own workspace's roster).
 */
const props = defineProps<{
  workspaceId: string;
  originalAgentId: string | null;
  taskId: string;
}>();

const model = defineModel<string | undefined>({ required: true });

const query = useAgents(props.workspaceId, { page_size: 100 });

const agents = computed<AgentResponse[]>(() =>
  (query.data.value?.items ?? []).filter((a) => a.enabled),
);

// Preselect the orchestrator once the roster is available; fall back to the
// original agent (orchestrator disabled — the feature's off-switch), then to
// the first eligible agent.
watch(
  agents,
  (list) => {
    if (model.value) return;
    const preferred =
      list.find((a) => a.is_orchestrator)?.id ??
      (props.originalAgentId && list.some((a) => a.id === props.originalAgentId)
        ? props.originalAgentId
        : list[0]?.id);
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
    <el-option
      v-for="a in agents"
      :key="a.id"
      :label="a.is_orchestrator ? `${a.name} (orchestrator)` : a.name"
      :value="a.id"
    />
  </el-select>
</template>

<style scoped lang="scss">
.agent-picker {
  min-width: 180px;
}
</style>

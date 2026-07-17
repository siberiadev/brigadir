<script setup lang="ts">
import { computed } from 'vue';
import { VueFlow, MarkerType } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import type { AgentResponse } from '@brigadir/contracts';
import { buildGraph, layoutGraph, type BoardStatus } from './buildGraph';
import StatusNode from './StatusNode.vue';
import AgentNode from './AgentNode.vue';

/**
 * Feature 018 — the diagram canvas. A DUMB component: the parent (AgentsList)
 * owns the queries and the create/edit dialog; this one derives the graph from
 * props and emits intents. That keeps "toggle fires no fetches" structurally
 * true (FR-003) and the whole graph a computed over shared query data.
 *
 * Pan/zoom/drag are Vue Flow built-ins; positions are recomputed from dagre on
 * every data change and never persisted (FR-014).
 */
const props = defineProps<{
  agents: AgentResponse[];
  statuses: BoardStatus[];
  loading?: boolean;
  error?: boolean;
}>();

const emit = defineEmits<{
  'create-agent': [statusName: string];
  'edit-agent': [agent: AgentResponse];
}>();

const model = computed(() => layoutGraph(buildGraph(props.agents, props.statuses)));

const nodes = computed(() => model.value.nodes);

// Edge kinds map to CSS classes (colors live in <style> via --el-color-*
// tokens, never hardcoded). No `animated` edges — marching ants are gratuitous
// motion (research R6).
const edges = computed(() =>
  model.value.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    class: `edge-${e.kind}`,
    animated: false,
    markerEnd: MarkerType.ArrowClosed,
  })),
);
</script>

<template>
  <div v-loading="loading" class="agents-diagram" data-test="agents-diagram">
    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      data-test="diagram-error"
      title="Diagram unavailable — could not load the board statuses or the agent roster."
      description="Both live sources are required; a partial graph would be misleading. Retry once the backend and Jira are reachable."
    />
    <template v-else>
      <el-empty
        v-if="!loading && model.visibleAgentCount === 0"
        class="agents-diagram__empty"
        data-test="diagram-empty"
        :image-size="48"
        description="No enabled worker agents yet — the board statuses below are waiting for a pipeline."
      />
      <VueFlow
        :nodes="nodes"
        :edges="edges"
        class="agents-diagram__canvas"
        fit-view-on-init
        :min-zoom="0.2"
        :max-zoom="2"
        :nodes-connectable="false"
        :edges-updatable="false"
        :delete-key-code="null"
      >
        <template #node-status="p">
          <StatusNode :data="p.data" @create="emit('create-agent', $event)" />
        </template>
        <template #node-agent="p">
          <AgentNode :data="p.data" @edit="emit('edit-agent', $event)" />
        </template>
      </VueFlow>
    </template>
  </div>
</template>

<style scoped lang="scss">
.agents-diagram {
  position: relative;
  margin-top: 12px;
}

.agents-diagram__canvas {
  height: clamp(420px, calc(100vh - 320px), 860px);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color-page);
}

.agents-diagram__empty {
  padding: 8px 0;
}

/* Edge styling by kind — brand/status colors only via theme tokens. */
.agents-diagram :deep(.vue-flow__edge-path) {
  stroke-width: 1.5;
}

.agents-diagram :deep(.edge-trigger .vue-flow__edge-path) {
  stroke: var(--el-color-primary);
}

.agents-diagram :deep(.edge-success .vue-flow__edge-path) {
  stroke: var(--el-color-success);
}

.agents-diagram :deep(.edge-failure .vue-flow__edge-path) {
  stroke: var(--el-color-danger);
  stroke-dasharray: 6 4;
}

/* The only non-essential motion is hover/zoom easing — kill it when asked. */
@media (prefers-reduced-motion: reduce) {
  .agents-diagram :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>

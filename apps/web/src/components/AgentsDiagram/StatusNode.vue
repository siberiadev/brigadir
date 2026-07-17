<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import { Plus, TriangleAlert } from 'lucide-vue-next';
import type { StatusNodeData } from './buildGraph';

// Board-status node. Kinds: normal (referenced by ≥1 visible agent), muted
// (on the board, referenced by nobody — a candidate for attaching agents),
// missing (referenced by an agent but gone from the board — visible drift).
// Icons are static — hover animation is sidebar-only (UI convention).
//
// The "+" (US2) lives on EVERY status node — outcome targets and muted
// candidates alike (spec assumption) — and opens the create form pre-aimed
// at this status.
defineProps<{ data: StatusNodeData }>();

const emit = defineEmits<{ create: [statusName: string] }>();
</script>

<template>
  <div class="status-node" :class="`status-node--${data.kind}`" data-test="diagram-status-node">
    <Handle type="target" :position="Position.Left" />
    <span class="status-node__name">{{ data.name }}</span>
    <el-tooltip
      v-if="data.kind === 'missing'"
      content="This status is not on the board anymore — the agent's mapping points nowhere."
    >
      <TriangleAlert class="status-node__warn" :size="14" data-test="status-missing-icon" />
    </el-tooltip>
    <el-tooltip content="New agent triggered by this status">
      <el-button
        class="status-node__add nodrag"
        size="small"
        circle
        data-test="status-add-agent"
        @click.stop="emit('create', data.name)"
      >
        <Plus :size="14" />
      </el-button>
    </el-tooltip>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>

<style scoped lang="scss">
.status-node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 160px;
  min-height: 56px;
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-size: 13px;
}

.status-node__name {
  flex: 1;
  overflow-wrap: anywhere;
}

.status-node--muted {
  opacity: 0.55;
  border-style: dashed;
  color: var(--el-text-color-secondary);
}

.status-node--missing {
  border-color: var(--el-color-danger);
}

.status-node__warn {
  flex-shrink: 0;
  color: var(--el-color-danger);
}

.status-node__add {
  flex-shrink: 0;
}

</style>

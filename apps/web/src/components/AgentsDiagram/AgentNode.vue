<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import { Bot, Pencil } from 'lucide-vue-next';
import type { AgentNodeData } from './buildGraph';

// Worker-agent node: persona name + role tag, and the JQL badge whose tooltip
// carries the raw JQL (FR-008) — shown both for jql-only agents (no trigger
// edge) and alongside a trigger edge. The edit button (US3) opens the same
// edit dialog as the table's Edit action. Icons static (UI convention).
defineProps<{ data: AgentNodeData }>();

const emit = defineEmits<{ edit: [agent: AgentNodeData['agent']] }>();
</script>

<template>
  <div class="agent-node" data-test="diagram-agent-node">
    <Handle type="target" :position="Position.Left" />
    <div class="agent-node__head">
      <Bot class="agent-node__icon" :size="16" />
      <span class="agent-node__name">{{ data.agent.name }}</span>
      <el-button
        class="agent-node__edit nodrag"
        size="small"
        text
        data-test="agent-edit"
        @click.stop="emit('edit', data.agent)"
      >
        <Pencil :size="14" />
      </el-button>
    </div>
    <div class="agent-node__meta">
      <el-tag v-if="data.agent.role" size="small" data-test="agent-role-tag">
        {{ data.agent.role }}
      </el-tag>
      <el-tooltip v-if="data.jql !== null" :content="data.jql">
        <el-tag size="small" type="warning" data-test="agent-jql-badge">JQL</el-tag>
      </el-tooltip>
    </div>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>

<style scoped lang="scss">
.agent-node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 200px;
  min-height: 84px;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-primary-light-9);
  color: var(--el-text-color-primary);
}

.agent-node__head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.agent-node__icon {
  flex-shrink: 0;
  color: var(--el-color-primary);
}

.agent-node__name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.agent-node__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
}
</style>

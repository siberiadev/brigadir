<script setup lang="ts">
import { ref } from 'vue';
import type { TicketHistoryRun } from '@brigadir/contracts';
import { ListChecks, Timer } from 'lucide-vue-next';
import RunStatusTag from '../RunStatusTag.vue';
import MarkdownText from '../MarkdownText.vue';
import { triggerLabel } from './presenter';
import { formatClockTime, formatDuration } from '../../utils/date';
import { formatCostUsd } from '../../utils/currency';

/**
 * One run entry of the ticket-history timeline — shared by main-pass, triage
 * and rework rows (the triage variant additionally shows the routing verdict).
 * Compact by default: the report summary is behind a per-card "Show more"
 * toggle (local state — collapses back on "Show less").
 */
const props = defineProps<{ run: TicketHistoryRun }>();
const emit = defineEmits<{ open: [runId: string] }>();

const summaryOpen = ref(false);

function metaLine(): string {
  const parts = [formatDuration(props.run.duration_ms)];
  const cost = formatCostUsd(props.run.cost_usd);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}
</script>

<template>
  <article
    class="run-block"
    :class="{ failed: run.status === 'failed' || run.status === 'timed_out' }"
    :data-test="`run-block-${run.run_id}`"
    @click="emit('open', run.run_id)"
  >
    <header class="run-head">
      <span class="time muted">{{ formatClockTime(run.created_at) }}</span>
      <el-tag :type="run.agent.is_orchestrator ? 'primary' : 'success'" size="small">
        {{ run.agent.name }}
      </el-tag>
      <span v-if="run.agent.role" class="role muted" :data-test="`role-${run.run_id}`">
        {{ run.agent.role }}
      </span>
      <span class="trigger muted" :data-test="`trigger-${run.run_id}`">{{ triggerLabel(run) }}</span>
      <RunStatusTag :status="run.status" size="small" />
      <span v-if="run.routing" class="routed-to muted" :data-test="`routed-to-${run.run_id}`">
        → {{ run.routing.target_agent }}
      </span>
      <span class="run-meta muted">
        <Timer :size="12" />
        {{ metaLine() }}
      </span>
      <el-button
        v-if="run.summary"
        link
        size="small"
        type="primary"
        class="summary-toggle"
        :data-test="`toggle-summary-${run.run_id}`"
        @click.stop="summaryOpen = !summaryOpen"
      >
        {{ summaryOpen ? 'Show less' : 'Show more' }}
      </el-button>
    </header>

    <MarkdownText
      v-if="run.summary && summaryOpen"
      :source="run.summary"
      class="run-summary"
      :data-test="`summary-${run.run_id}`"
    />

    <div v-if="run.failed_checks.length > 0" class="chips" :data-test="`failed-checks-${run.run_id}`">
      <el-tooltip
        v-for="(c, ci) in run.failed_checks"
        :key="ci"
        :content="c.reason ?? c.name"
        placement="top"
      >
        <el-tag type="danger" size="small" effect="plain">{{ c.name }}</el-tag>
      </el-tooltip>
    </div>

    <div v-if="run.human_tasks.length > 0" class="chips">
      <el-tag v-for="t in run.human_tasks" :key="t.id" type="warning" size="small" effect="plain">
        {{ t.kind }}: {{ t.title }}
      </el-tag>
    </div>

    <el-collapse v-if="run.routing" class="routing-task" @click.stop>
      <el-collapse-item :name="run.run_id">
        <template #title>
          <span class="routing-title">
            <ListChecks :size="13" />
            Rework task for {{ run.routing.target_agent }}
          </span>
        </template>
        <MarkdownText :source="run.routing.task" />
      </el-collapse-item>
    </el-collapse>
  </article>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-block {
  padding: $space-sm $space-md;
  border-radius: $radius-sm;
  cursor: pointer;

  &:hover {
    background: var(--el-fill-color-light);
  }
  &.failed {
    border: 1px solid var(--el-color-danger-light-7);
  }
}
.run-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-sm;
  font-size: 13px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.time {
  font-family: $font-family-mono;
  font-size: 12px;
}
.role {
  font-size: 12px;
}
.trigger {
  font-size: 12px;
}
.run-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  margin-left: auto;
}
.routed-to {
  font-size: 12px;
}
.summary-toggle {
  font-size: 12px;
}
.run-summary {
  margin-top: $space-xs;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: $space-xs;
  margin-top: $space-xs;
}
.routing-task {
  margin-top: $space-xs;
  border-top: none;
  border-bottom: none;

  :deep(.el-collapse-item__header) {
    height: 32px;
    font-size: 12px;
    background: transparent;
  }
  :deep(.el-collapse-item:last-child .el-collapse-item__header) {
    border-bottom: none;
  }
}
.routing-title {
  display: inline-flex;
  align-items: center;
  gap: $space-xs;
  color: var(--el-text-color-secondary);
}
</style>

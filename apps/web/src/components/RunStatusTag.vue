<script setup lang="ts">
/**
 * The run-status tag — single home for the status→tag-type map (was duplicated
 * in Runs.vue and RunCard.vue). A `running` status gets a pulsing dot (looping
 * "agent is alive" indicator): this is deliberately NOT AnimatedIcon, whose
 * contract is one-shot-on-hover; state-driven loops live here.
 */
import type { RunStatus } from '@brigadir/contracts';

withDefaults(defineProps<{ status: RunStatus; size?: 'small' | 'default' }>(), {
  size: 'default',
});

const STATUS_TAG_TYPE: Record<string, string> = {
  succeeded: 'success',
  running: 'primary',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'info',
  superseded: 'info',
  awaiting_human: 'warning',
  queued: 'info',
};
</script>

<template>
  <el-tag :type="STATUS_TAG_TYPE[status] ?? 'info'" :size="size" data-test="run-status">
    <span v-if="status === 'running'" class="pulse-dot" data-test="status-pulse" />
    {{ status }}
  </el-tag>
</template>

<style scoped lang="scss">
.pulse-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  vertical-align: middle;
  background: var(--el-color-primary);
  animation: pulse-ring 1.4s cubic-bezier(0.2, 0, 0.4, 1) infinite;
}

@keyframes pulse-ring {
  0% {
    box-shadow: 0 0 0 0 rgba(var(--el-color-primary-rgb), 0.5);
  }
  100% {
    box-shadow: 0 0 0 5px rgba(var(--el-color-primary-rgb), 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  // The dot stays as a static indicator; only the motion goes.
  .pulse-dot {
    animation: none;
  }
}
</style>

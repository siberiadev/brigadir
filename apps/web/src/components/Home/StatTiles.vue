<script setup lang="ts">
/**
 * The four stat tiles (feature 017, US2). Purely presentational: the parent
 * passes the atomic summary so all counters render from ONE response moment.
 * The failed tile flips to danger styling when non-zero; the running tile
 * reuses the RunStatusTag pulse-dot idiom (state indicator, not hover anim).
 */
import { computed } from 'vue';
import type { HomeSummaryResponse } from '@brigadir/contracts';

const props = defineProps<{ summary?: HomeSummaryResponse; error: boolean }>();

const attentionTotal = computed(() =>
  props.summary ? props.summary.attention_24h.failed + props.summary.attention_24h.timed_out : 0,
);
</script>

<template>
  <div v-if="error && !summary" class="block-error" data-test="tiles-error">
    Couldn't load the summary — retrying.
  </div>
  <div v-else class="tiles" data-test="stat-tiles">
    <el-card class="tile" shadow="never" data-test="tile-running">
      <div class="label"><span class="pulse-dot" aria-hidden="true" /> Running</div>
      <div class="value">{{ summary?.running ?? 0 }}</div>
    </el-card>
    <el-card class="tile" shadow="never" data-test="tile-queued">
      <div class="label">Queued</div>
      <div class="value">{{ summary?.queued ?? 0 }}</div>
    </el-card>
    <el-card class="tile" shadow="never" data-test="tile-attention">
      <div class="label">Failed · last 24h</div>
      <div class="value" :class="{ 'is-danger': attentionTotal > 0 }" data-test="tile-attention-value">
        {{ attentionTotal }}
      </div>
      <div class="sub" data-test="tile-attention-sub">
        {{ summary?.attention_24h.failed ?? 0 }} failed ·
        {{ summary?.attention_24h.timed_out ?? 0 }} timed out
      </div>
    </el-card>
    <el-card class="tile" shadow="never" data-test="tile-human">
      <div class="label">Awaiting human</div>
      <div class="value">{{ summary?.human_open ?? 0 }}</div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: $space-lg;

  @media (max-width: 1080px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.label {
  display: flex;
  align-items: center;
  gap: $space-sm;
  font-size: 12.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--el-text-color-secondary);
}
.value {
  font-size: 28px;
  font-weight: $font-weight-bold;
  line-height: 1.3;

  &.is-danger {
    color: var(--el-color-danger);
  }
}
.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
// Same state-indicator idiom as RunStatusTag's pulse (looping, not hover-driven).
.pulse-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
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
  .pulse-dot {
    animation: none;
  }
}
.block-error {
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>

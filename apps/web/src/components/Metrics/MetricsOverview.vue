<script setup lang="ts">
import { computed } from 'vue';
import type { MetricsFilterParams } from '../../api/metrics';
import { useMetricsOverview } from '../../composables/useMetrics';
import { formatCostUsd } from '../../utils/currency';
import { formatDuration } from '../../utils/date';
import { metricSeriesLabel } from '../../utils/metricsLabels';
import { STATUS_COLOR_ROLE } from '../../charts/echarts';

/**
 * Overview tab (US1): five compact summary cards for the period — a bird's-eye
 * of the other four tabs. Explicit zeros/dashes rather than an empty state, so
 * the landing view always reads (US1 independent test).
 */
const props = defineProps<{ filters: MetricsFilterParams }>();

const query = useMetricsOverview(() => props.filters);
const data = computed(() => query.data.value);

const totalRuns = computed(() => {
  const c = data.value?.run_count_by_status;
  return c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
});

// Non-zero status breakdown, ordered by the canonical status list.
const statusBreakdown = computed(() => {
  const c = data.value?.run_count_by_status;
  if (!c) return [];
  return (Object.keys(c) as (keyof typeof c)[])
    .filter((k) => c[k] > 0)
    .map((k) => ({ key: k, count: c[k], role: STATUS_COLOR_ROLE[k] ?? 'info' }));
});

const successRateLabel = computed(() => {
  const r = data.value?.success_rate;
  return r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`;
});

const medianLabel = computed(() => {
  const s = data.value?.median_duration_s;
  return s === null || s === undefined ? '—' : formatDuration(s * 1000);
});
</script>

<template>
  <div v-loading="query.isLoading.value" class="metrics-overview" data-test="metrics-overview">
    <el-card class="ov-card" shadow="never" data-test="ov-cost">
      <div class="ov-card__label">Spend (period)</div>
      <div class="ov-card__value">{{ formatCostUsd(data?.total_cost_usd) ?? '$0.00' }}</div>
    </el-card>

    <el-card class="ov-card" shadow="never" data-test="ov-runs">
      <div class="ov-card__label">Runs</div>
      <div class="ov-card__value">{{ totalRuns }}</div>
      <div class="ov-card__breakdown">
        <span v-if="statusBreakdown.length === 0" class="ov-card__muted">no runs</span>
        <span
          v-for="s in statusBreakdown"
          :key="s.key"
          class="ov-status"
          :data-test="`ov-status-${s.key}`"
        >
          <span class="ov-status__dot" :style="{ background: `var(--el-color-${s.role})` }" />
          {{ metricSeriesLabel(s.key) }}
          <b>{{ s.count }}</b>
        </span>
      </div>
    </el-card>

    <el-card class="ov-card" shadow="never" data-test="ov-success">
      <div class="ov-card__label">Success rate</div>
      <div class="ov-card__value">{{ successRateLabel }}</div>
    </el-card>

    <el-card class="ov-card" shadow="never" data-test="ov-median">
      <div class="ov-card__label">Median duration</div>
      <div class="ov-card__value">{{ medianLabel }}</div>
    </el-card>

    <el-card class="ov-card" shadow="never" data-test="ov-human">
      <div class="ov-card__label">Open human tasks</div>
      <div class="ov-card__value">{{ data?.open_human_tasks ?? 0 }}</div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-overview {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: $space-md;
  min-height: 120px;
}
.ov-card {
  &__label {
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }
  &__value {
    margin-top: $space-xs;
    font-size: 26px;
    font-weight: $font-weight-medium;
    font-variant-numeric: tabular-nums;
  }
  &__breakdown {
    margin-top: $space-sm;
    display: flex;
    flex-wrap: wrap;
    gap: $space-sm;
    font-size: 12px;
    color: var(--el-text-color-regular);
  }
  &__muted {
    color: var(--el-text-color-secondary);
  }
}
.ov-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
}
</style>

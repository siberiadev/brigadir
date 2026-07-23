<script setup lang="ts">
import { computed } from 'vue';
import type { MetricsFilterParams } from '../../api/metrics';
import { useMetricsHuman } from '../../composables/useMetrics';
import { isSeriesEmpty, timeSeriesOption, useChartTheme } from '../../charts/echarts';
import { humanTaskKindLabel } from '../../utils/metricsLabels';
import ChartCard from './ChartCard.vue';

/**
 * Human-in-the-loop tab (US5): resolution latency (median/p95), opened vs closed
 * tasks by kind, and the share of runs awaiting a human. The share is labelled
 * «сейчас в ожидании» — v1 uses the current status as an approximation (no
 * transition log exists yet; data-model note).
 */
const props = defineProps<{ filters: MetricsFilterParams }>();

const query = useMetricsHuman(() => props.filters);
const data = computed(() => query.data.value);
const theme = useChartTheme();
const loading = computed(() => query.isLoading.value);

// Latency median + p95 merged into one chart.
const latencyTb = computed(() =>
  data.value
    ? {
        granularity: data.value.latency_median_s.granularity,
        buckets: data.value.latency_median_s.buckets,
        series: [
          { key: 'median', points: data.value.latency_median_s.series[0]?.points ?? [] },
          { key: 'p95', points: data.value.latency_p95_s.series[0]?.points ?? [] },
        ],
      }
    : null,
);
const latencyOption = computed(() =>
  latencyTb.value
    ? timeSeriesOption(theme.value, latencyTb.value, 'line', {
        labelFn: (k) => (k === 'median' ? 'Median' : 'p95'),
      })
    : null,
);

const openedOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.opened_by_kind, 'bar', {
        stack: true,
        labelFn: humanTaskKindLabel,
      })
    : null,
);
const closedOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.closed_by_kind, 'bar', {
        stack: true,
        labelFn: humanTaskKindLabel,
      })
    : null,
);
const shareOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.awaiting_human_share, 'line', {
        percent: true,
        labelFn: () => 'Awaiting now',
      })
    : null,
);
</script>

<template>
  <div class="metrics-human" data-test="metrics-human">
    <ChartCard
      title="Resolution latency (s)"
      :option="latencyOption"
      :loading="loading"
      :empty="isSeriesEmpty(latencyTb ?? undefined)"
    />
    <ChartCard
      title="Opened tasks by kind"
      :option="openedOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.opened_by_kind)"
    />
    <ChartCard
      title="Closed tasks by kind"
      :option="closedOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.closed_by_kind)"
    />
    <ChartCard
      title="Share of runs awaiting human"
      :option="shareOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.awaiting_human_share)"
    >
      <template #header-extra>
        <el-tooltip
          content="v1: uses the current awaiting_human status (no transition log yet)"
          placement="top"
        >
          <span class="muted" data-test="share-note">awaiting now</span>
        </el-tooltip>
      </template>
    </ChartCard>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-human {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: $space-md;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: help;
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import type { MetricsFilterParams } from '../../api/metrics';
import { useMetricsReliability } from '../../composables/useMetrics';
import {
  STATUS_COLOR_ROLE,
  isSeriesEmpty,
  timeSeriesOption,
  useChartTheme,
} from '../../charts/echarts';
import { metricSeriesLabel } from '../../utils/metricsLabels';
import ChartCard from './ChartCard.vue';

/**
 * Run Reliability tab (US3): status mix over time, success/retry rates,
 * median & p95 duration, and failure counts by executor. Statuses reuse the
 * RunStatusTag color mapping so a status looks the same on the chart as on a tag.
 */
const props = defineProps<{ filters: MetricsFilterParams }>();

const query = useMetricsReliability(() => props.filters);
const data = computed(() => query.data.value);
const theme = useChartTheme();
const loading = computed(() => query.isLoading.value);

// Status series colored by role (primary/success/danger/… from the brand vars).
const statusColor = (key: string) => theme.value[STATUS_COLOR_ROLE[key] ?? 'info'];

const statusOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.runs_by_status, 'line', {
        stack: true,
        area: true,
        labelFn: metricSeriesLabel,
        colorFn: statusColor,
      })
    : null,
);

const successOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.success_rate, 'line', {
        percent: true,
        labelFn: () => 'Success rate',
      })
    : null,
);

const retryOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.retry_rate, 'line', {
        percent: true,
        labelFn: () => 'Retry rate',
      })
    : null,
);

// Median + p95 merged into one duration chart (two lines).
const durationTb = computed(() =>
  data.value
    ? {
        granularity: data.value.duration_median_s.granularity,
        buckets: data.value.duration_median_s.buckets,
        series: [
          { key: 'median', points: data.value.duration_median_s.series[0]?.points ?? [] },
          { key: 'p95', points: data.value.duration_p95_s.series[0]?.points ?? [] },
        ],
      }
    : null,
);
const durationOption = computed(() =>
  durationTb.value
    ? timeSeriesOption(theme.value, durationTb.value, 'line', {
        labelFn: (k) => (k === 'median' ? 'Median' : 'p95'),
      })
    : null,
);

const failOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.failstats_by_executor, 'bar', { stack: true })
    : null,
);
</script>

<template>
  <div class="metrics-reliability" data-test="metrics-reliability">
    <ChartCard
      title="Runs by status"
      :option="statusOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.runs_by_status)"
    />
    <ChartCard
      title="Success rate"
      :option="successOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.success_rate)"
    />
    <ChartCard
      title="Duration: median & p95 (s)"
      :option="durationOption"
      :loading="loading"
      :empty="isSeriesEmpty(durationTb ?? undefined)"
    />
    <ChartCard
      title="Retry rate"
      :option="retryOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.retry_rate)"
    />
    <ChartCard
      title="Failures by executor (failed + timed out)"
      :option="failOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.failstats_by_executor)"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-reliability {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: $space-md;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
}
</style>

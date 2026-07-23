<script setup lang="ts">
import { computed } from 'vue';
import type { MetricsFilterParams } from '../../api/metrics';
import { useMetricsActivity } from '../../composables/useMetrics';
import { isSeriesEmpty, timeSeriesOption, useChartTheme } from '../../charts/echarts';
import { metricSeriesLabel } from '../../utils/metricsLabels';
import ChartCard from './ChartCard.vue';

/**
 * Activity & Triggers tab (US4): three independent breakdowns of the run count
 * — by trigger source, by agent role, and by workspace. NULL source/role fall
 * into the «не определено» category (FR-014/FR-017); by-workspace series carry
 * the workspace name as label straight from the backend.
 */
const props = defineProps<{ filters: MetricsFilterParams }>();

const query = useMetricsActivity(() => props.filters);
const data = computed(() => query.data.value);
const theme = useChartTheme();
const loading = computed(() => query.isLoading.value);

const sourceOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.by_source, 'bar', {
        stack: true,
        labelFn: metricSeriesLabel,
      })
    : null,
);
const roleOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.by_role, 'bar', {
        stack: true,
        labelFn: metricSeriesLabel,
      })
    : null,
);
const workspaceOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.by_workspace, 'bar', { stack: true })
    : null,
);
</script>

<template>
  <div class="metrics-activity" data-test="metrics-activity">
    <ChartCard
      title="Runs by trigger source"
      :option="sourceOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.by_source)"
    />
    <ChartCard
      title="Runs by agent role"
      :option="roleOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.by_role)"
    />
    <ChartCard
      title="Runs by workspace"
      :option="workspaceOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.by_workspace)"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-activity {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: $space-md;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
}
</style>

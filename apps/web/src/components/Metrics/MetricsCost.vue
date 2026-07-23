<script setup lang="ts">
import { computed } from 'vue';
import type { MetricsFilterParams } from '../../api/metrics';
import { useMetricsCost } from '../../composables/useMetrics';
import {
  categoryBarOption,
  isSeriesEmpty,
  timeSeriesOption,
  useChartTheme,
} from '../../charts/echarts';
import { metricSeriesLabel, tokenTypeLabel } from '../../utils/metricsLabels';
import { isIndicativeExecutor } from '../../utils/executorCost';
import { formatCostUsd } from '../../utils/currency';
import ChartCard from './ChartCard.vue';

/**
 * Cost & Usage tab (US2): spend stacked by executor, tokens by type, average
 * cost per run, and top workspaces by spend. Provider-preset executors
 * (kimi/deepseek_api) are flagged as indicative (FR-008). The top-workspaces
 * chart is meaningless with a single workspace selected, so it hides then.
 */
const props = defineProps<{ filters: MetricsFilterParams }>();

const query = useMetricsCost(() => props.filters);
const data = computed(() => query.data.value);
const theme = useChartTheme();
const loading = computed(() => query.isLoading.value);

const costOption = computed(() =>
  data.value ? timeSeriesOption(theme.value, data.value.cost_by_executor, 'bar', { stack: true }) : null,
);
const tokensByExecutorOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.tokens_by_executor, 'bar', { stack: true })
    : null,
);
const tokensByModelOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.tokens_by_model, 'bar', {
        stack: true,
        labelFn: metricSeriesLabel,
      })
    : null,
);
const tokensOption = computed(() =>
  data.value
    ? timeSeriesOption(theme.value, data.value.tokens_by_type, 'line', { labelFn: tokenTypeLabel })
    : null,
);
const cprOption = computed(() =>
  data.value ? timeSeriesOption(theme.value, data.value.cost_per_run, 'line') : null,
);

// Indicative caveat when a provider-preset executor is in the stack (FR-008).
const hasIndicative = computed(() =>
  (data.value?.cost_by_executor.series ?? []).some((s) => isIndicativeExecutor(s.key)),
);

// Top workspaces: only when no single workspace is selected (US2 AS3).
const showTopWorkspaces = computed(() => !props.filters.workspace_id);
const topWorkspaces = computed(() => data.value?.top_workspaces_by_cost ?? []);
const topOption = computed(() =>
  data.value
    ? categoryBarOption(
        theme.value,
        topWorkspaces.value.map((w) => w.name),
        topWorkspaces.value.map((w) => Number(w.total_cost_usd)),
      )
    : null,
);
</script>

<template>
  <div class="metrics-cost" data-test="metrics-cost">
    <ChartCard
      title="Spend by executor"
      :option="costOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.cost_by_executor)"
    >
      <template #header-extra>
        <el-tooltip
          v-if="hasIndicative"
          content="kimi/deepseek_api: cost is estimated (Anthropic pricing), not billed"
          placement="top"
        >
          <sup class="indicative-mark" data-test="cost-indicative">est. ~</sup>
        </el-tooltip>
      </template>
    </ChartCard>

    <ChartCard
      title="Tokens by executor"
      :option="tokensByExecutorOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.tokens_by_executor)"
      data-test="tokens-by-executor"
    />

    <ChartCard
      title="Tokens by model"
      :option="tokensByModelOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.tokens_by_model)"
      data-test="tokens-by-model"
    />

    <ChartCard
      title="Tokens by type"
      :option="tokensOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.tokens_by_type)"
    />

    <ChartCard
      title="Average cost per run"
      :option="cprOption"
      :loading="loading"
      :empty="isSeriesEmpty(data?.cost_per_run)"
    />

    <ChartCard
      v-if="showTopWorkspaces"
      title="Top workspaces by spend"
      :option="topOption"
      :loading="loading"
      :empty="topWorkspaces.length === 0"
      data-test="top-workspaces"
    >
      <template #header-extra>
        <span v-if="topWorkspaces.length" class="muted">
          leader: {{ formatCostUsd(topWorkspaces[0].total_cost_usd) }}
        </span>
      </template>
    </ChartCard>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-cost {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: $space-md;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
}
.indicative-mark {
  color: var(--el-color-warning);
  font-weight: $font-weight-medium;
  cursor: help;
  font-size: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>

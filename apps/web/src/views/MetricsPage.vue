<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { RunCostPeriod } from '@brigadir/contracts';
import MetricsFilters from '../components/Metrics/MetricsFilters.vue';
import MetricsOverview from '../components/Metrics/MetricsOverview.vue';
import MetricsCost from '../components/Metrics/MetricsCost.vue';
import MetricsReliability from '../components/Metrics/MetricsReliability.vue';
import MetricsActivity from '../components/Metrics/MetricsActivity.vue';
import MetricsHuman from '../components/Metrics/MetricsHuman.vue';

/**
 * The /metrics page (feature 029): shared top-of-page filters + an el-tabs with
 * five lazily-mounted panels (Обзор default). The active tab and the three
 * filters round-trip through the URL query-string (R11/SC-002) so a view is
 * shareable and survives reload. Panels mount lazily (FR-004): a tab's data is
 * fetched only once it is first opened.
 */

type TabKey = 'overview' | 'cost' | 'reliability' | 'activity' | 'human';
const TAB_KEYS: TabKey[] = ['overview', 'cost', 'reliability', 'activity', 'human'];

const route = useRoute();
const router = useRouter();

const PERIODS: RunCostPeriod[] = ['24h', '7d', '30d'];
function asPeriod(v: unknown): RunCostPeriod {
  return typeof v === 'string' && (PERIODS as string[]).includes(v) ? (v as RunCostPeriod) : '7d';
}
function asTab(v: unknown): TabKey {
  return typeof v === 'string' && (TAB_KEYS as string[]).includes(v) ? (v as TabKey) : 'overview';
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Initial state seeded from the URL so a shared link lands on the right view.
const activeTab = ref<TabKey>(asTab(route.query.tab));
const filters = reactive({
  period: asPeriod(route.query.period),
  workspace_id: asStr(route.query.workspace),
  executor_type: asStr(route.query.executor),
});

// executor_type is not applicable on the Human tab (H1/FR-011a).
const executorApplicable = () => activeTab.value !== 'human';

/** The query object that reflects the current state. */
function stateQuery(): Record<string, string> {
  return {
    tab: activeTab.value,
    period: filters.period,
    ...(filters.workspace_id ? { workspace: filters.workspace_id } : {}),
    ...(filters.executor_type ? { executor: filters.executor_type } : {}),
  };
}

const sameQuery = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  ['tab', 'period', 'workspace', 'executor'].every((k) => (a[k] ?? '') === (b[k] ?? ''));

// Route → state: seed on setup AND catch a later resolution or a back/forward
// nav (the shared-link case — a `?tab=cost` URL must open the cost panel).
watch(
  () => route.query,
  () => {
    const t = asTab(route.query.tab);
    if (t !== activeTab.value) activeTab.value = t;
    const p = asPeriod(route.query.period);
    if (p !== filters.period) filters.period = p;
    const ws = asStr(route.query.workspace);
    if (ws !== filters.workspace_id) filters.workspace_id = ws;
    const ex = asStr(route.query.executor);
    if (ex !== filters.executor_type) filters.executor_type = ex;
  },
);

// State → URL (replace, so filter tweaks don't spam history). Guarded so it
// never fights the route→state sync above.
watch(
  [activeTab, () => ({ ...filters })],
  () => {
    const q = stateQuery();
    if (!sameQuery(route.query, q)) router.replace({ query: q });
  },
  { deep: true },
);
</script>

<template>
  <section class="metrics-page" data-test="metrics-page">
    <div class="metrics-page__header">
      <h2>Metrics</h2>
    </div>

    <MetricsFilters
      v-model:period="filters.period"
      v-model:workspace-id="filters.workspace_id"
      v-model:executor-type="filters.executor_type"
      :executor-applicable="executorApplicable()"
    />

    <el-tabs v-model="activeTab" class="metrics-page__tabs" data-test="metrics-tabs">
      <el-tab-pane label="Overview" name="overview" lazy>
        <MetricsOverview :filters="filters" />
      </el-tab-pane>
      <el-tab-pane label="Cost & tokens" name="cost" lazy>
        <MetricsCost :filters="filters" />
      </el-tab-pane>
      <el-tab-pane label="Run health" name="reliability" lazy>
        <MetricsReliability :filters="filters" />
      </el-tab-pane>
      <el-tab-pane label="Activity & triggers" name="activity" lazy>
        <MetricsActivity :filters="filters" />
      </el-tab-pane>
      <el-tab-pane label="Human in the loop" name="human" lazy>
        <MetricsHuman :filters="filters" />
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.metrics-page {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
}
</style>

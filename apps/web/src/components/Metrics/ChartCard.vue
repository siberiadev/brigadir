<script setup lang="ts">
import { computed } from 'vue';
import VChart from 'vue-echarts';
// Side-effect import: registers the tree-shaken ECharts pieces before <v-chart>
// renders (feature 029, R1).
import '../../charts/echarts';

/**
 * Reusable chart panel (feature 029): a titled card wrapping a themed
 * `<v-chart>`. Shows the stock circular spinner while loading and an el-empty
 * state when there is no data (FR-016), so every metrics chart handles the
 * three states identically.
 */
const props = withDefaults(
  defineProps<{
    title: string;
    option: Record<string, unknown> | null;
    loading?: boolean;
    /** True when the series carry no data — renders the empty state. */
    empty?: boolean;
    /** Chart body height. */
    height?: number;
    emptyDescription?: string;
  }>(),
  { loading: false, empty: false, height: 260, emptyDescription: 'No data for the period' },
);

const bodyStyle = computed(() => ({ height: `${props.height}px` }));
</script>

<template>
  <el-card class="chart-card" shadow="never" data-test="chart-card">
    <template #header>
      <div class="chart-card__header">
        <span class="chart-card__title">{{ title }}</span>
        <slot name="header-extra" />
      </div>
    </template>
    <div v-loading="loading" class="chart-card__body" :style="bodyStyle">
      <el-empty
        v-if="empty && !loading"
        :description="emptyDescription"
        :image-size="72"
        data-test="chart-empty"
      />
      <v-chart
        v-else-if="option"
        class="chart-card__chart"
        :option="option"
        autoresize
        data-test="chart-canvas"
      />
    </div>
  </el-card>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chart-card {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: $space-sm;
  }
  &__title {
    font-weight: $font-weight-medium;
  }
  &__body {
    position: relative;
    width: 100%;
  }
  &__chart {
    width: 100%;
    height: 100%;
  }
}
</style>

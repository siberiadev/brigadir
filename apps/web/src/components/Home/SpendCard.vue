<script setup lang="ts">
/**
 * Platform-wide spend (feature 017, US6). All three period figures ride the
 * atomic summary the parent passes down, so the switcher is pure local state —
 * flipping periods performs ZERO network requests. Same el-radio-group idiom
 * as the per-workspace cost header (Runs.vue); default period 24h.
 */
import { computed, ref } from 'vue';
import type { HomeSummaryResponse, RunCostPeriod } from '@brigadir/contracts';
import { formatCostUsd } from '../../utils/currency';

const props = defineProps<{ summary?: HomeSummaryResponse; error: boolean }>();

const period = ref<RunCostPeriod>('24h');
const entry = computed(() => props.summary?.spend[period.value]);
</script>

<template>
  <el-card data-test="spend-card">
    <template #header>
      <div class="card-head">
        <h3>Spend</h3>
        <el-radio-group v-model="period" size="small" data-test="spend-period">
          <el-radio-button label="24h" value="24h">24h</el-radio-button>
          <el-radio-button label="7d" value="7d">7d</el-radio-button>
          <el-radio-button label="30d" value="30d">30d</el-radio-button>
        </el-radio-group>
      </div>
    </template>

    <div v-if="error && !summary" class="block-error" data-test="spend-error">
      Couldn't load spend — retrying.
    </div>
    <template v-else>
      <div class="total" data-test="spend-total">
        {{ formatCostUsd(entry?.total_cost_usd) ?? '$0.00' }}
      </div>
      <div class="meta" data-test="spend-meta">
        {{ entry?.run_count ?? 0 }} runs · all workspaces
      </div>
    </template>
  </el-card>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}
.total {
  font-size: 26px;
  font-weight: $font-weight-bold;
}
.meta {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}
.block-error {
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>

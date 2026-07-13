<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { RunCostPeriod, RunListItem, RunStatus } from '@brigadir/contracts';
import { useRuns, useRunsCost } from '../composables/useRuns';
import { useAgents } from '../composables/useAgents';
import { useWorkspaces } from '../composables/useWorkspaces';
import { formatDuration } from '../utils/date';

const props = defineProps<{ id: string }>();
const router = useRouter();

const workspacesQuery = useWorkspaces();
const workspace = computed(() =>
  (workspacesQuery.data.value ?? []).find((w) => w.id === props.id),
);

const agentsQuery = useAgents(props.id);

const STATUS_OPTIONS: RunStatus[] = [
  'queued',
  'running',
  'awaiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'superseded',
];

// Filters + pagination. Any filter change resets to page 1.
const filters = reactive({ agent: '', status: '', ticket: '', page: 1, page_size: 25 });
watch(
  () => [filters.agent, filters.status, filters.ticket],
  () => {
    filters.page = 1;
  },
);

const listParams = computed(() => ({
  agent: filters.agent || undefined,
  status: filters.status || undefined,
  ticket: filters.ticket || undefined,
  page: filters.page,
  page_size: filters.page_size,
}));

const runsQuery = useRuns(props.id, listParams);
const rows = computed<RunListItem[]>(() => runsQuery.data.value?.items ?? []);
const total = computed(() => runsQuery.data.value?.total ?? 0);

// Cost header with period presets.
const period = ref<RunCostPeriod>('7d');
const costQuery = useRunsCost(props.id, period);

const statusTagType: Record<string, string> = {
  succeeded: 'success',
  running: 'primary',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'info',
  superseded: 'info',
  awaiting_human: 'warning',
  queued: 'info',
};

function openRun(row: RunListItem) {
  router.push(`/runs/${row.run_id}`);
}
</script>

<template>
  <section class="runs">
    <div class="header-row">
      <h2>Runs — {{ workspace?.name ?? id }}</h2>
      <div class="cost" data-test="cost-header">
        <el-radio-group v-model="period" size="small" data-test="cost-period">
          <el-radio-button label="24h" value="24h">24h</el-radio-button>
          <el-radio-button label="7d" value="7d">7d</el-radio-button>
          <el-radio-button label="30d" value="30d">30d</el-radio-button>
        </el-radio-group>
        <span class="cost-total" data-test="cost-total">
          ${{ costQuery.data.value?.total_cost_usd ?? '0' }}
          <span class="muted">· {{ costQuery.data.value?.run_count ?? 0 }} runs</span>
        </span>
      </div>
    </div>

    <div class="filters">
      <el-select
        v-model="filters.agent"
        clearable
        placeholder="All agents"
        data-test="filter-agent"
        class="filter-control"
      >
        <el-option
          v-for="ag in agentsQuery.data.value ?? []"
          :key="ag.id"
          :label="ag.name"
          :value="ag.id"
        />
      </el-select>
      <el-select
        v-model="filters.status"
        clearable
        placeholder="All statuses"
        data-test="filter-status"
        class="filter-control"
      >
        <el-option v-for="s in STATUS_OPTIONS" :key="s" :label="s" :value="s" />
      </el-select>
      <el-input
        v-model="filters.ticket"
        clearable
        placeholder="Ticket key (BRIG-…)"
        data-test="filter-ticket"
        class="filter-control"
      />
    </div>

    <el-empty
      v-if="!runsQuery.isLoading.value && rows.length === 0"
      description="No runs match these filters."
      data-test="runs-empty"
    />

    <el-table
      v-else
      v-loading="runsQuery.isLoading.value"
      :data="rows"
      data-test="runs-table"
      row-key="run_id"
      @row-click="openRun"
    >
      <el-table-column label="Agent">
        <template #default="{ row }">{{ row.agent.name }}</template>
      </el-table-column>
      <el-table-column label="Ticket">
        <template #default="{ row }">
          <a :href="row.ticket.jira_url" target="_blank" rel="noopener" @click.stop>
            {{ row.ticket.key }}
          </a>
        </template>
      </el-table-column>
      <el-table-column label="Status">
        <template #default="{ row }">
          <el-tag :type="statusTagType[row.status] ?? 'info'" size="small">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="attempt" label="Attempt" width="90" />
      <el-table-column label="Duration">
        <template #default="{ row }">{{ formatDuration(row.duration_ms) }}</template>
      </el-table-column>
      <el-table-column label="Cost">
        <template #default="{ row }">{{ row.cost_usd != null ? `$${row.cost_usd}` : '—' }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="total > filters.page_size"
      layout="prev, pager, next"
      :total="total"
      :page-size="filters.page_size"
      :current-page="filters.page"
      data-test="runs-pagination"
      @current-change="(p: number) => (filters.page = p)"
    />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.cost {
  display: flex;
  align-items: center;
  gap: $space-md;
}
.cost-total {
  font-weight: $font-weight-medium;
}
.muted {
  color: var(--el-text-color-secondary);
  font-weight: $font-weight-regular;
  font-size: 13px;
}
.filters {
  display: flex;
  gap: $space-md;
  margin: $space-lg 0;
}
.filter-control {
  width: 220px;
}
.el-table {
  cursor: pointer;
}
</style>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { RunCostPeriod, RunListItem, RunStatus } from '@brigadir/contracts';
import { MAX_PAGE_SIZE } from '@brigadir/contracts/pagination';
import { useRuns, useRunsCost, useCancelAllRuns } from '../composables/useRuns';
import { useAgents } from '../composables/useAgents';
import { usePagination } from '../composables/usePagination';
import { useNow } from '../composables/useNow';
import ListPagination from '../components/ListPagination.vue';
import RunStatusTag from '../components/RunStatusTag.vue';
import { formatDuration } from '../utils/date';
import { formatCostUsd } from '../utils/currency';

const props = defineProps<{ id: string }>();
const router = useRouter();

// Пикер: потребитель ВСЕГО списка агентов — не листает (UI-конвенция 2026-07-15).
const agentsQuery = useAgents(props.id, { page: 1, page_size: MAX_PAGE_SIZE });

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

// Filters + pagination. Any filter change resets to page 1 (usePagination).
const filters = reactive({ agent: '', status: '', ticket: '' });
const { page, pageSize, params, bindTotal } = usePagination({
  resetOn: () => [filters.agent, filters.status, filters.ticket],
});

const listParams = computed(() => ({
  agent: filters.agent || undefined,
  status: filters.status || undefined,
  ticket: filters.ticket || undefined,
  ...params.value,
}));

const runsQuery = useRuns(props.id, listParams);
const rows = computed<RunListItem[]>(() => runsQuery.data.value?.items ?? []);
const total = computed(() => runsQuery.data.value?.total ?? 0);
bindTotal(total);

// Cost header with period presets.
const period = ref<RunCostPeriod>('7d');
const costQuery = useRunsCost(props.id, period);

// Live Duration on `running` rows: tick from `started_at` every second instead
// of the server-computed `duration_ms`, which goes stale between 5 s polls.
const now = useNow();
function liveDuration(row: RunListItem): string {
  if (row.status === 'running' && row.started_at) {
    // Clamped: client/server clock skew must not render a negative duration.
    return formatDuration(Math.max(0, now.value.getTime() - Date.parse(row.started_at)));
  }
  return formatDuration(row.duration_ms);
}

function openRun(row: RunListItem) {
  router.push(`/runs/${row.run_id}`);
}

// Bulk stop: queued + running → cancelled after an explicit confirmation.
// `awaiting_human` runs are untouched server-side (rule #7), which the
// dialog spells out so "stop all" never reads as "clears the human queue".
const cancelAll = useCancelAllRuns(props.id);
async function stopAllRuns() {
  try {
    await ElMessageBox.confirm(
      'Cancel every queued and running run in this workspace? Runs awaiting a human are not affected. This cannot be undone.',
      'Stop all runs',
      { confirmButtonText: 'Stop all', cancelButtonText: 'Cancel', type: 'warning' },
    );
  } catch {
    return; // dismissed
  }
  const res = await cancelAll.mutateAsync();
  ElMessage.success(
    res.cancelled_count === 0
      ? 'No active runs to stop.'
      : `Cancelled ${res.cancelled_count} run${res.cancelled_count === 1 ? '' : 's'}.`,
  );
}
</script>

<template>
  <section class="runs">
    <div class="header-row">
      <h2>Runs</h2>
      <div class="cost" data-test="cost-header">
        <el-button
          type="danger"
          plain
          size="small"
          data-test="stop-all-runs"
          :loading="cancelAll.isPending.value"
          @click="stopAllRuns"
        >
          Stop all runs
        </el-button>
        <el-radio-group v-model="period" size="small" data-test="cost-period">
          <el-radio-button label="24h" value="24h">24h</el-radio-button>
          <el-radio-button label="7d" value="7d">7d</el-radio-button>
          <el-radio-button label="30d" value="30d">30d</el-radio-button>
        </el-radio-group>
        <span class="cost-total" data-test="cost-total">
          {{ formatCostUsd(costQuery.data.value?.total_cost_usd) ?? '$0.00' }}
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
          v-for="ag in agentsQuery.data.value?.items ?? []"
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
      <el-table-column label="Role">
        <!-- feature 016: the agent's function per run; em dash when the agent has none. -->
        <template #default="{ row }">{{ row.agent?.role || '—' }}</template>
      </el-table-column>
      <el-table-column label="Ticket">
        <template #default="{ row }">
          <!-- feature 011: ticketless workspace-setup runs get a label, no link. -->
          <a v-if="row.ticket" :href="row.ticket.jira_url" target="_blank" rel="noopener" @click.stop>
            {{ row.ticket.key }}
          </a>
          <span v-else class="setup-label" data-test="setup-label">Workspace setup</span>
        </template>
      </el-table-column>
      <el-table-column label="Status">
        <template #default="{ row }">
          <RunStatusTag :status="row.status" size="small" />
        </template>
      </el-table-column>
      <el-table-column prop="attempt" label="Attempt" width="90" />
      <el-table-column label="Duration">
        <template #default="{ row }">{{ liveDuration(row) }}</template>
      </el-table-column>
      <el-table-column label="Cost">
        <template #default="{ row }">{{ formatCostUsd(row.cost_usd) ?? '—' }}</template>
      </el-table-column>
    </el-table>

    <ListPagination :total="total" v-model:page="page" v-model:page-size="pageSize" />
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

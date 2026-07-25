<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { BlockedState } from '@brigadir/contracts';
import { ExternalLink, RefreshCw } from 'lucide-vue-next';
import { useTicketHistory } from '../composables/useTicketHistory';
import BackLink from '../components/BackLink.vue';
import HistoryRunCard from '../components/TicketHistory/HistoryRunCard.vue';
import { presentHistory } from '../components/TicketHistory/presenter';
import { formatCostUsd } from '../utils/currency';
import { pluralize } from '../utils/pluralize';
import { blockedStateTag, blockedStateLabel, blockedStateHint } from '../utils/blockedState';

/**
 * Ticket history page — how the agents worked one ticket: the main pass plus
 * collapsed rework cycles (triage verdict + the rework run it dispatched), the
 * fail-reason chips, and the "Open Jira" escape hatch (ticket keys across the
 * dashboard link HERE; Jira is one explicit click away). Addressed by
 * (workspace, jira key) — the route prop is `ticketKey` because `key` is a
 * reserved Vue prop name.
 */
const props = defineProps<{ id: string; ticketKey: string }>();

const query = useTicketHistory(props.id, props.ticketKey);
const data = computed(() => query.data.value);
const vm = computed(() => presentHistory(data.value?.runs ?? []));

const router = useRouter();
function openRun(runId: string) {
  router.push({ name: 'run-card', params: { id: runId } });
}

const aggregatesLabel = computed(() => {
  const a = data.value?.aggregates;
  if (!a) return '';
  const parts = [pluralize(a.runs_total, 'run'), pluralize(a.rework_cycles, 'rework cycle')];
  const cost = formatCostUsd(a.total_cost_usd);
  if (cost) parts.push(cost);
  return parts.join(' · ');
});
</script>

<template>
  <section v-if="data" class="ticket-history" data-test="ticket-history">
    <BackLink :to="`/workspaces/${props.id}/runs`" label="Runs" class="back" />

    <div class="header-row">
      <h2 class="title" data-test="th-ticket-key">
        {{ data.ticket.key }}
        <span class="summary">{{ data.ticket.summary ?? '(no summary)' }}</span>
      </h2>
      <a
        :href="data.ticket.jira_url"
        target="_blank"
        rel="noopener"
        class="open-jira"
        data-test="open-jira"
      >
        <el-button plain size="small">
          <ExternalLink :size="12" />
          <span class="btn-label">Open Jira</span>
        </el-button>
      </a>
    </div>

    <div class="sub muted">
      <el-tag v-if="data.ticket.last_seen_status" size="small" data-test="th-jira-status">
        {{ data.ticket.last_seen_status }}
      </el-tag>
      <el-tag v-if="data.ticket.priority_name" size="small" type="info" effect="plain">
        {{ data.ticket.priority_name }}
      </el-tag>
      <el-tooltip
        v-if="data.ticket.blocked_state"
        :content="blockedStateHint[data.ticket.blocked_state as BlockedState]"
        placement="top"
      >
        <el-tag size="small" :type="blockedStateTag[data.ticket.blocked_state as BlockedState]">
          {{ blockedStateLabel[data.ticket.blocked_state as BlockedState] }}
        </el-tag>
      </el-tooltip>
      <span class="ws-name">{{ data.workspace.name }}</span>
      <span class="aggregates" data-test="th-aggregates">{{ aggregatesLabel }}</span>
    </div>

    <el-empty
      v-if="vm.blocks.length === 0"
      description="No runs for this ticket yet."
      :image-size="72"
      data-test="th-no-runs"
    />

    <!-- Timeline: main pass runs + collapsed rework cycles -->
    <div v-else class="timeline">
      <template v-for="block in vm.blocks" :key="block.kind === 'run' ? block.run.run_id : `cycle-${block.index}`">
        <HistoryRunCard v-if="block.kind === 'run'" :run="block.run" @open="openRun" />

        <section v-else class="cycle-block" :data-test="`cycle-${block.index}`">
          <header class="cycle-head">
            <RefreshCw :size="13" />
            Rework cycle {{ block.index }}
          </header>
          <HistoryRunCard :run="block.triage" @open="openRun" />
          <HistoryRunCard v-for="rework in block.reworks" :key="rework.run_id" :run="rework" @open="openRun" />
        </section>
      </template>
    </div>
  </section>

  <el-empty
    v-else-if="query.isError.value"
    description="Ticket not found."
    data-test="ticket-not-found"
  />
  <el-skeleton v-else :rows="6" animated />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ticket-history {
  max-width: 900px;
}
.back {
  margin-bottom: $space-sm;
}
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-sm;
}
.title {
  margin: 0;
  min-width: 0;
}
.summary {
  font-weight: $font-weight-regular;
  margin-left: $space-sm;
  color: var(--el-text-color-regular);
}
.open-jira {
  flex-shrink: 0;
  text-decoration: none;
}
.btn-label {
  margin-left: $space-xs;
}
.sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-sm;
  font-size: 13px;
  margin: $space-sm 0 $space-lg;
}
.muted {
  color: var(--el-text-color-secondary);
}
.ws-name {
  font-size: 12px;
}
.aggregates {
  margin-left: auto;
}
.timeline {
  display: flex;
  flex-direction: column;
  gap: $space-sm;
  border-left: 2px solid var(--el-border-color);
  padding-left: $space-md;
}
.cycle-block {
  display: flex;
  flex-direction: column;
  gap: $space-sm;
  border-left: 2px solid var(--el-color-primary-light-5);
  margin-left: $space-sm;
  padding-left: $space-md;
}
.cycle-head {
  display: inline-flex;
  align-items: center;
  gap: $space-xs;
  font-size: 12px;
  color: var(--el-color-primary);
  margin-bottom: 0;
}
</style>

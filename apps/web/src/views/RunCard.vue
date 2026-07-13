<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { RunCheckStatus, RunStatus } from '@brigadir/contracts';
import { useRunCard, useCancelRun, useRetryRun } from '../composables/useRunCard';
import { ApiError } from '../api/client';
import { formatDuration } from '../utils/date';

const props = defineProps<{ id: string }>();

const cardQuery = useRunCard(props.id);
const card = computed(() => cardQuery.data.value);
const run = computed(() => card.value?.run);

// A run is actionable (cancel) only while running; retry only once terminal.
const isRunning = computed(() => run.value?.status === 'running');
const isTerminal = computed(() =>
  (['succeeded', 'failed', 'cancelled', 'timed_out', 'superseded'] as RunStatus[]).includes(
    run.value?.status as RunStatus,
  ),
);

const cancel = useCancelRun(props.id);
const retry = useRetryRun(props.id);

async function onCancel() {
  try {
    const res = await cancel.mutateAsync();
    ElMessage[res.cancelled ? 'success' : 'warning'](
      res.cancelled ? 'Run cancelled.' : 'Run is no longer running — not cancelled.',
    );
  } catch (err) {
    ElMessage.error((err as Error)?.message ?? 'Cancel failed.');
  }
}

async function onRetry() {
  try {
    const res = await retry.mutateAsync();
    ElMessage.success(`Retry enqueued — run ${res.run_id}.`);
  } catch (err) {
    const msg =
      err instanceof ApiError && err.code === 'active_run_exists'
        ? 'An active run already exists for this ticket and agent.'
        : (err as Error)?.message ?? 'Retry failed.';
    ElMessage.error(msg);
  }
}

// Expandable check reasons, keyed by position.
const expanded = ref<Record<number, boolean>>({});
function toggle(position: number) {
  expanded.value[position] = !expanded.value[position];
}

const CHECK_GLYPH: Record<RunCheckStatus, string> = {
  pass: '✅',
  fail: '❌',
  warn: '⚠️',
  skip: '⏭️',
};

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

function eventPayload(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}
</script>

<template>
  <section v-if="card && run" class="run-card">
    <!-- Header: ticket + status + Jira deep link -->
    <div class="header-row">
      <div>
        <h2 data-test="ticket-key">
          <a :href="card.ticket.jira_url" target="_blank" rel="noopener">{{ card.ticket.key }}</a>
          <span class="summary">{{ card.ticket.summary ?? '(no summary)' }}</span>
        </h2>
        <div class="sub muted">
          {{ run.agent.name }} · {{ run.executor_type }} · attempt {{ run.attempt }} ·
          {{ formatDuration(run.duration_ms) }} ·
          {{ run.cost_usd != null ? `$${run.cost_usd}` : 'no cost' }}
        </div>
      </div>
      <div class="header-actions">
        <el-tag :type="statusTagType[run.status] ?? 'info'" data-test="run-status">{{ run.status }}</el-tag>
        <el-button
          v-if="isRunning"
          type="danger"
          plain
          data-test="cancel-run"
          :loading="cancel.isPending.value"
          @click="onCancel"
        >
          Cancel
        </el-button>
        <el-button
          v-if="isTerminal"
          type="primary"
          plain
          data-test="retry-run"
          :loading="retry.isPending.value"
          @click="onRetry"
        >
          Retry
        </el-button>
      </div>
    </div>

    <!-- Report checklist -->
    <el-card class="block">
      <template #header>Report</template>
      <el-empty v-if="card.checks.length === 0" description="No report checks (partial report)." data-test="checks-empty" />
      <ul v-else class="checks" data-test="checks">
        <li v-for="c in card.checks" :key="c.position" :data-test="`check-${c.position}`">
          <button
            type="button"
            class="check-row"
            :data-test="`check-toggle-${c.position}`"
            @click="toggle(c.position)"
          >
            <span class="glyph" :data-test="`glyph-${c.position}`">{{ CHECK_GLYPH[c.status] }}</span>
            <span class="check-name">{{ c.name }}</span>
            <span v-if="c.reason" class="muted expand-hint">{{ expanded[c.position] ? '▾' : '▸' }}</span>
          </button>
          <div
            v-if="c.reason && expanded[c.position]"
            class="reason"
            :data-test="`reason-${c.position}`"
          >
            {{ c.reason }}
          </div>
        </li>
      </ul>
    </el-card>

    <!-- Failure diagnostics -->
    <el-card v-if="run.error" class="block">
      <template #header>Failure diagnostics</template>
      <pre class="diagnostics" data-test="run-error">{{ run.error }}</pre>
      <a v-if="run.external_ref" :href="run.external_ref" target="_blank" rel="noopener" data-test="external-ref">
        {{ run.external_ref }}
      </a>
    </el-card>

    <!-- Run history for the ticket -->
    <el-card class="block">
      <template #header>Run history</template>
      <el-table :data="card.history" data-test="history-table">
        <el-table-column prop="agent" label="Agent" />
        <el-table-column prop="executor_type" label="Executor" />
        <el-table-column prop="attempt" label="Attempt" width="90" />
        <el-table-column label="Duration">
          <template #default="{ row }">{{ formatDuration(row.duration_ms) }}</template>
        </el-table-column>
        <el-table-column label="Cost">
          <template #default="{ row }">{{ row.cost_usd != null ? `$${row.cost_usd}` : '—' }}</template>
        </el-table-column>
        <el-table-column prop="status" label="Outcome" />
      </el-table>
    </el-card>

    <!-- Event timeline -->
    <el-card class="block">
      <template #header>Timeline</template>
      <el-timeline data-test="timeline">
        <el-timeline-item
          v-for="e in card.events"
          :key="e.id"
          :timestamp="new Date(e.created_at).toLocaleString()"
        >
          <strong>{{ e.type }}</strong>
          <span v-if="eventPayload(e.payload)" class="muted"> — {{ eventPayload(e.payload) }}</span>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </section>

  <el-empty
    v-else-if="cardQuery.isError.value"
    description="Run not found."
    data-test="run-not-found"
  />
  <el-skeleton v-else :rows="6" animated />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-card {
  max-width: 900px;
}
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: $space-lg;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: $space-sm;
}
.summary {
  font-weight: $font-weight-regular;
  margin-left: $space-sm;
  color: var(--el-text-color-regular);
}
.sub {
  font-size: 13px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.block {
  margin-bottom: $space-lg;
}
.checks {
  list-style: none;
  padding: 0;
  margin: 0;
}
.check-row {
  display: flex;
  align-items: center;
  gap: $space-sm;
  width: 100%;
  background: none;
  border: none;
  padding: $space-xs 0;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}
.glyph {
  width: 1.4em;
}
.expand-hint {
  margin-left: auto;
}
.reason {
  margin: 0 0 $space-sm 1.9em;
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.diagnostics {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--el-fill-color-light);
  padding: $space-md;
  border-radius: $radius-sm;
  margin: 0 0 $space-sm;
  font-size: 12px;
}
</style>

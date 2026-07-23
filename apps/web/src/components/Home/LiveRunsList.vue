<script setup lang="ts">
/**
 * "What is running right now" (feature 017, US4): running+queued runs across
 * ALL workspaces, server-ordered (running longest-first, then queued
 * longest-waiting first). Running rows tick every second between polls,
 * anchored on `started_at` and clamped ≥ 0 against clock skew — the exact
 * Runs.vue ticker pattern.
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { GlobalRunListItem } from '@brigadir/contracts';
import { useGlobalRuns } from '../../composables/useGlobalRuns';
import { useNow } from '../../composables/useNow';
import RunStatusTag from '../RunStatusTag.vue';
import { formatDuration, relativeAge } from '../../utils/date';

const router = useRouter();
const runsQuery = useGlobalRuns({ status: 'running,queued', limit: 10 });
const items = computed<GlobalRunListItem[]>(() => runsQuery.data.value?.items ?? []);
const total = computed(() => runsQuery.data.value?.total ?? 0);

const now = useNow();
function liveDuration(item: GlobalRunListItem): string {
  if (item.status === 'running' && item.started_at) {
    return formatDuration(Math.max(0, now.value.getTime() - Date.parse(item.started_at)));
  }
  return formatDuration(item.duration_ms);
}

function openRun(item: GlobalRunListItem) {
  router.push(`/runs/${item.run_id}`);
}
</script>

<template>
  <el-card shadow="never" data-test="live-runs" :body-style="{ padding: '0' }">
    <template #header>
      <div class="card-head">
        <h3>Live runs</h3>
      </div>
    </template>

    <div v-if="runsQuery.isError.value" class="block-error" data-test="live-error">
      Couldn't load live runs — retrying.
    </div>
    <el-empty
      v-else-if="!runsQuery.isLoading.value && items.length === 0"
      description="Nothing running right now."
      :image-size="48"
      data-test="live-empty"
    />
    <template v-else>
      <ul class="rows" data-test="live-rows">
        <li
          v-for="item in items"
          :key="item.run_id"
          class="row"
          data-test="live-row"
          @click="openRun(item)"
        >
          <RunStatusTag :status="item.status" size="small" />
          <div class="row-body">
            <div class="title-line">
              <span v-if="item.ticket" class="ticket">{{ item.ticket.key }}</span>
              <span v-else class="ticket setup">Workspace setup</span>
            </div>
            <div class="meta">{{ item.agent.name }} · {{ item.workspace.name }}</div>
          </div>
          <span v-if="item.status === 'running'" class="ticker" data-test="live-ticker">
            {{ liveDuration(item) }}
          </span>
          <span v-else class="when" data-test="live-queued-age">
            in queue {{ relativeAge(item.created_at) }}
          </span>
        </li>
      </ul>
      <div v-if="total > items.length" class="overflow-note" data-test="live-overflow">
        showing {{ items.length }} of {{ total }}
      </div>
    </template>
  </el-card>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.card-head {
  display: flex;
  align-items: center;

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: $font-weight-medium;
  }
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: $space-md;
  padding: $space-md $space-lg;
  cursor: pointer;

  & + .row {
    border-top: 1px solid var(--el-border-color-lighter);
  }
  &:hover {
    background: var(--el-fill-color-light);
  }
}
.row-body {
  min-width: 0;
  flex: 1;
}
.title-line {
  display: flex;
  min-width: 0;
}
.ticket {
  font-family: $font-family-mono;
  font-size: 12.5px;
  color: var(--el-color-primary);

  &.setup {
    color: var(--el-text-color-secondary);
  }
}
.meta {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}
.ticker {
  flex: none;
  font-family: $font-family-mono;
  font-size: 12.5px;
}
.when {
  flex: none;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}
.overflow-note {
  padding: $space-sm $space-lg;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}
.block-error {
  padding: $space-lg;
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>

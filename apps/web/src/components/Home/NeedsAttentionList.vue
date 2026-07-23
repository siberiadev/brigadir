<script setup lang="ts">
/**
 * "What broke while I was away" (feature 017, US3): failed/timed_out runs from
 * the last 24h across ALL workspaces, newest finished first (server ordering).
 * Rows open the run card. Overflow beyond the top 10 renders a "showing N of M"
 * note — there is no global runs page to link (runs browse per workspace).
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { GlobalRunListItem } from '@brigadir/contracts';
import { useGlobalRuns } from '../../composables/useGlobalRuns';
import RunStatusTag from '../RunStatusTag.vue';
import { relativeAge } from '../../utils/date';

const router = useRouter();
const runsQuery = useGlobalRuns({ status: 'failed,timed_out', finished_within: '24h', limit: 10 });
const items = computed<GlobalRunListItem[]>(() => runsQuery.data.value?.items ?? []);
const total = computed(() => runsQuery.data.value?.total ?? 0);

function openRun(item: GlobalRunListItem) {
  router.push(`/runs/${item.run_id}`);
}
</script>

<template>
  <el-card shadow="never" data-test="attention-list" :body-style="{ padding: '0' }">
    <template #header>
      <div class="card-head">
        <h3>Needs attention</h3>
        <span v-if="total > 0" class="danger-chip" data-test="attention-count">{{ total }} in 24h</span>
      </div>
    </template>

    <div v-if="runsQuery.isError.value" class="block-error" data-test="attention-error">
      Couldn't load recent failures — retrying.
    </div>
    <el-empty
      v-else-if="!runsQuery.isLoading.value && items.length === 0"
      description="Nothing broke in the last 24h."
      :image-size="48"
      data-test="attention-empty"
    />
    <template v-else>
      <ul class="rows" data-test="attention-rows">
        <li
          v-for="item in items"
          :key="item.run_id"
          class="row"
          data-test="attention-row"
          @click="openRun(item)"
        >
          <RunStatusTag :status="item.status" size="small" />
          <div class="row-body">
            <div class="title-line">
              <span v-if="item.ticket" class="ticket">{{ item.ticket.key }}</span>
              <span v-else class="ticket setup">Workspace setup</span>
              <span v-if="item.ticket?.summary" class="title">{{ item.ticket.summary }}</span>
            </div>
            <div class="meta">
              {{ item.agent.name }} · {{ item.workspace.name }} · attempt {{ item.attempt }}
            </div>
          </div>
          <span v-if="item.finished_at" class="when" data-test="attention-when">
            {{ relativeAge(item.finished_at) }} ago
          </span>
        </li>
      </ul>
      <div v-if="total > items.length" class="overflow-note" data-test="attention-overflow">
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
  gap: $space-sm;

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: $font-weight-medium;
  }
}
.danger-chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--el-color-danger-light-8);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
  font-size: 12px;
  font-weight: $font-weight-medium;
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
  gap: $space-sm;
  align-items: baseline;
  min-width: 0;
}
.ticket {
  font-family: $font-family-mono;
  font-size: 12.5px;
  color: var(--el-color-primary);
  flex: none;

  &.setup {
    color: var(--el-text-color-secondary);
  }
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
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

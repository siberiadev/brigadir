<script setup lang="ts">
import { computed } from 'vue';
import type { BlockedState } from '@brigadir/contracts';
import { useWaitingTickets } from '../composables/useWaitingTickets';
import { usePagination } from '../composables/usePagination';
import ListPagination from '../components/ListPagination.vue';

/**
 * Feature 022 (US3): blocked-waiting tickets of the workspace — "waiting on
 * [keys]" with the sequencing classification. Pure read of the release pass's
 * diff cache; order is the canonical release order (priority, then key).
 */
const props = defineProps<{ id: string }>();

const { page, pageSize, params, bindTotal } = usePagination();
const query = useWaitingTickets(props.id, params);
const total = computed(() => query.data.value?.total ?? 0);
bindTotal(total);
const items = computed(() => query.data.value?.items ?? []);

// cycle is the strongest "will never self-resolve" signal → danger; dead-end /
// out-of-scope need a human → warning; plain waiting is informational.
const stateTag: Record<BlockedState, 'info' | 'warning' | 'danger'> = {
  waiting: 'info',
  cycle: 'danger',
  dead_end: 'warning',
  out_of_scope: 'warning',
};
const stateLabel: Record<BlockedState, string> = {
  waiting: 'Waiting',
  cycle: 'Cycle',
  dead_end: 'Dead end',
  out_of_scope: 'Out of scope',
};
const stateHint: Record<BlockedState, string> = {
  waiting: 'Blocked by open tickets; starts automatically once they are done.',
  cycle: 'These tickets block each other — break the cycle on the board.',
  dead_end: 'A blocker is closed outside the Done category and will never complete.',
  out_of_scope: 'A blocker is outside this board scope — see the Human queue task.',
};
</script>

<template>
  <section>
    <el-table v-loading="query.isLoading.value" :data="items">
      <el-table-column label="Ticket" prop="jira_key" width="120" />
      <el-table-column label="Summary" prop="summary" min-width="220" show-overflow-tooltip />
      <el-table-column label="Priority" width="110">
        <template #default="{ row }">
          <span v-if="row.priority_name">{{ row.priority_name }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="Waiting on" min-width="160">
        <template #default="{ row }">
          <el-tag
            v-for="key in row.blocked_by"
            :key="key"
            size="small"
            type="info"
            effect="plain"
            class="blocker-tag"
          >
            {{ key }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="State" width="140">
        <template #default="{ row }">
          <el-tooltip :content="stateHint[row.blocked_state as BlockedState]" placement="top">
            <el-tag size="small" :type="stateTag[row.blocked_state as BlockedState]">
              {{ stateLabel[row.blocked_state as BlockedState] }}
            </el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="No tickets are waiting on blockers." :image-size="72" />
      </template>
    </el-table>

    <ListPagination :total="total" v-model:page="page" v-model:page-size="pageSize" />
  </section>
</template>

<style scoped lang="scss">
.blocker-tag {
  margin-right: 4px;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>

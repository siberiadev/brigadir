<script setup lang="ts">
/**
 * The hero block (feature 017, US1): "does the system need me?". Reuses the
 * existing open human-tasks list with the explicit `order=oldest` opt-in — the
 * hero surfaces the LONGEST-waiting decisions (the queue page itself defaults
 * to newest-first since feature 016). The header count is the SAME response's
 * `total`, so count and rows can never disagree within the block.
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { HumanQueueItem } from '@brigadir/contracts';
import { useHumanTasks } from '../../composables/useHumanTasks';
import { relativeAge } from '../../utils/date';

const HERO_PAGE_SIZE = 5;

const router = useRouter();
const tasksQuery = useHumanTasks('open', { page: 1, page_size: HERO_PAGE_SIZE }, undefined, 'oldest');
const items = computed<HumanQueueItem[]>(() => tasksQuery.data.value?.items ?? []);
const total = computed(() => tasksQuery.data.value?.total ?? 0);

function openTask(item: HumanQueueItem) {
  // The run card is where the task gets answered; ticketless/runless system
  // tasks fall back to the full queue page.
  if (item.run_id) router.push(`/runs/${item.run_id}`);
  else router.push('/human-queue');
}
</script>

<template>
  <el-card class="hero" data-test="home-hero" :body-style="{ padding: '0' }">
    <template #header>
      <div class="hero-head">
        <h3>Needs your decision</h3>
        <span class="count-chip" data-test="hero-count">{{ total }}</span>
        <RouterLink to="/human-queue" class="head-link" data-test="hero-open-queue">
          Open queue →
        </RouterLink>
      </div>
    </template>

    <div v-if="tasksQuery.isError.value" class="block-error" data-test="hero-error">
      Couldn't load the human queue — retrying.
    </div>
    <el-empty
      v-else-if="!tasksQuery.isLoading.value && items.length === 0"
      description="Nothing is waiting on you."
      :image-size="48"
      data-test="hero-empty"
    />
    <ul v-else class="rows" data-test="hero-rows">
      <li
        v-for="item in items"
        :key="item.id"
        class="row"
        data-test="hero-row"
        @click="openTask(item)"
      >
        <div class="row-body">
          <div class="title-line">
            <span v-if="item.ticket" class="ticket">{{ item.ticket.key }}</span>
            <span v-else class="ticket setup">Workspace setup</span>
            <span class="title">{{ item.title }}</span>
          </div>
          <div class="meta">
            <template v-if="item.agent">{{ item.agent.name }} · </template>
            {{ item.workspace.name }} ·
            <span class="wait" data-test="hero-wait">waiting {{ relativeAge(item.created_at) }}</span>
          </div>
        </div>
        <el-button size="small" data-test="hero-review">Review</el-button>
      </li>
    </ul>
  </el-card>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// The most prominent block on the page: primary-tinted header.
.hero :deep(.el-card__header) {
  background: var(--el-color-primary-light-9);
}
.hero-head {
  display: flex;
  align-items: center;
  gap: $space-sm;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}
.count-chip {
  min-width: 22px;
  text-align: center;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--el-color-primary);
  color: var(--el-color-white);
  font-size: 12px;
  font-weight: $font-weight-bold;
}
.head-link {
  margin-left: auto;
  font-size: 13px;
  color: var(--el-color-primary);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
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
  font-weight: $font-weight-medium;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wait {
  color: var(--el-color-warning);
}
.block-error {
  padding: $space-lg;
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>

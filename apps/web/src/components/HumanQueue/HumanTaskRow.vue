<script setup lang="ts">
import { computed } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import type { HumanQueueItem } from '@brigadir/contracts';
import { relativeAge } from '../../utils/date';
import { pluralize } from '../../utils/pluralize';
import { badgeState, badgeTooltip, kindIcon } from './kindTag';

/**
 * Compact row for the needs-human queue: a square icon badge in the left
 * column, two content lines in the right one. The badge glyph is the task
 * `kind`; its color is the run state (parked/waiting/resolved) — the two are
 * orthogonal and both live in the data. Line 1: title; line 2: ticket, agent,
 * age, and (closed tasks) the resolution. The whole row opens the detail
 * drawer; the Jira link stops propagation so it never triggers it.
 */
const props = defineProps<{ item: HumanQueueItem }>();

const emit = defineEmits<{ select: [id: string] }>();

const state = computed(() => badgeState(props.item));
</script>

<template>
  <li
    class="task-row"
    role="button"
    tabindex="0"
    :data-test="`task-${item.id}`"
    @click="emit('select', item.id)"
    @keydown.enter.prevent="emit('select', item.id)"
    @keydown.space.prevent="emit('select', item.id)"
  >
    <div
      class="kind-badge"
      :class="`state-${state}`"
      :aria-label="`${item.kind} — ${badgeTooltip[state]}`"
      data-test="kind-badge"
      :data-state="state"
    >
      <component :is="kindIcon[item.kind]" :size="18" />
    </div>
    <div class="content">
      <div class="line-main">
        <span class="title" data-test="task-title">{{ item.title }}</span>
        <ChevronRight class="chevron" :size="14" />
      </div>
      <div class="line-meta">
        <!-- feature 011: ticketless setup tasks get a label, no link. -->
        <a
          v-if="item.ticket"
          :href="item.ticket.jira_url"
          target="_blank"
          rel="noopener"
          data-test="task-ticket"
          @click.stop
        >
          {{ item.ticket.key }}
        </a>
        <span v-else data-test="task-setup-label">Workspace setup</span>
        <span v-if="item.agent">· {{ item.agent.name }}</span>
        <span data-test="task-age">· {{ relativeAge(item.created_at) }} ago</span>
        <!-- feature 013: hint that the drawer offers one-click answers (open tasks only). -->
        <span v-if="!item.status && item.options?.length" :data-test="`options-hint-${item.id}`">
          · {{ pluralize(item.options.length, 'option') }}
        </span>
        <!-- Closed tasks: the badge color already signals resolved/dismissed,
             so the row shows just the resolution text + resolver, no status tag. -->
        <span v-if="item.status" class="line-resolution" :data-test="`resolution-${item.id}`">
          <span v-if="item.resolution" class="resolution-text">· {{ item.resolution }}</span>
          <span v-if="item.resolved_by" :data-test="`resolver-${item.id}`">
            · by {{ item.resolved_by }}
          </span>
        </span>
      </div>
    </div>
  </li>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.task-row {
  display: flex;
  align-items: flex-start;
  gap: $space-md;
  padding: $space-sm $space-md;
  border-radius: $radius-sm;
  cursor: pointer;

  &:hover {
    background: var(--el-fill-color-light);
  }
  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: -2px;
  }
}
.kind-badge {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: $radius-md;

  // Color encodes run state, not kind (see badgeState).
  &.state-blocking {
    color: var(--el-color-danger);
    background: var(--el-color-danger-light-9);
  }
  &.state-waiting {
    color: var(--el-color-warning);
    background: var(--el-color-warning-light-9);
  }
  &.state-resolved {
    color: var(--el-color-success);
    background: var(--el-color-success-light-9);
  }
  &.state-dismissed {
    color: var(--el-color-info);
    background: var(--el-color-info-light-9);
  }
}
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: $space-xs;
}
.line-main {
  display: flex;
  align-items: center;
  gap: $space-sm;
  min-width: 0;
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: $font-weight-medium;
}
.chevron {
  flex: none;
  color: var(--el-text-color-secondary);
}
.line-meta {
  display: flex;
  align-items: center;
  gap: $space-xs;
  min-width: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.line-resolution {
  display: flex;
  align-items: center;
  gap: $space-xs;
  min-width: 0;
  margin-left: $space-xs;
}
.resolution-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

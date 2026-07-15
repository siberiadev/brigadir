<script setup lang="ts">
/**
 * Human-friendly run event timeline, newest first. One item per event:
 * `time · icon · title`, with the command / message shown in full in a grey
 * block right below — nothing is hidden behind an expand control.
 * A custom list, not el-timeline — el-timeline-item hard-codes the timestamp
 * and node markup and fights the row layout.
 */
import { computed, type Component } from 'vue';
import type { RunCardEvent } from '@brigadir/contracts';
import {
  Activity,
  CircleDot,
  Info,
  RotateCcw,
  Ticket,
  TriangleAlert,
  Wrench,
} from 'lucide-vue-next';
import { presentEvents, type TimelineTypeKey } from './presenter';

const props = defineProps<{ events: RunCardEvent[] }>();

// Newest first — during a live run the fresh events matter, no scrolling to
// the bottom for them. presentEvents needs the chronological order for the
// report_progress dedup (it pairs an event with its successor), so reverse after.
const items = computed(() => presentEvents(props.events).reverse());

const ICONS: Record<TimelineTypeKey, Component> = {
  tool_call: Wrench,
  progress: Activity,
  log: Info,
  jira_action: Ticket,
  api_retry: RotateCcw,
  error: TriangleAlert,
  unknown: CircleDot,
};
</script>

<template>
  <ul class="timeline" data-test="timeline">
    <li
      v-for="item in items"
      :key="item.id"
      class="event"
      :class="`event--${item.typeKey}`"
    >
      <div class="row" :data-test="`event-${item.id}`">
        <span class="time" :title="item.timeTitle">{{ item.time }}</span>
        <span class="node">
          <component :is="ICONS[item.typeKey]" :size="13" />
        </span>
        <span class="title">{{ item.title }}</span>
        <span v-if="item.percent != null" class="percent">{{ item.percent }}%</span>
      </div>
      <pre v-if="item.body" class="body" :data-test="`event-body-${item.id}`">{{ item.body }}</pre>
    </li>
  </ul>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// Row column metrics — the rail and the body indent derive from these.
$time-width: 62px;
$node-size: 24px;
$rail-x: $time-width + $space-sm + ($node-size / 2); // center of the node chip
$body-indent: $time-width + $space-sm + $node-size + $space-sm;

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}

.event {
  position: relative;
  padding-bottom: $space-xs;

  // Vertical rail through the node column; first/last items clip it so the
  // line starts/ends at their chips instead of bleeding past the list.
  &::before {
    content: '';
    position: absolute;
    left: $rail-x - 1px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--el-border-color-lighter);
  }
  &:first-child::before {
    top: $node-size;
  }
  &:last-child::before {
    bottom: calc(100% - #{$node-size});
  }
  &:first-child:last-child::before {
    display: none;
  }
}

// Per-type accent consumed by the node chip.
.event--tool_call {
  --type-color: var(--el-color-primary);
}
.event--progress {
  --type-color: var(--el-color-success);
}
.event--log {
  --type-color: var(--el-color-info);
}
.event--jira_action,
.event--api_retry {
  --type-color: var(--el-color-warning);
}
.event--error {
  --type-color: var(--el-color-danger);
}
.event--unknown {
  --type-color: var(--el-text-color-secondary);
}

.row {
  display: flex;
  align-items: center;
  gap: $space-sm;
  padding: $space-xs 0;
}

.time {
  flex: none;
  width: $time-width;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.node {
  flex: none;
  position: relative; // sits on top of the rail
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: $node-size;
  height: $node-size;
  border-radius: 50%;
  color: var(--type-color);
  background: var(--el-fill-color-light);
}

.title {
  flex: 1;
  min-width: 0;
  font-weight: $font-weight-medium;
  font-size: 13px;
  word-break: break-word;
}

.percent {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.body {
  margin: 0 0 $space-xs $body-indent;
  padding: $space-sm;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: $radius-sm;
}
</style>

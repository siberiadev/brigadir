<script setup lang="ts">
/**
 * Human-friendly run event timeline, newest first. Each entry is a
 * `<TimelineEvent>` (`time · icon · title` + body); this component owns only the
 * ordered list and the report_progress dedup. A custom list, not el-timeline —
 * el-timeline-item hard-codes the timestamp/node markup and fights the layout.
 */
import { computed } from 'vue';
import type { RunCardEvent } from '@brigadir/contracts';
import { presentEvents } from './presenter';
import TimelineEvent from './TimelineEvent.vue';

const props = defineProps<{ events: RunCardEvent[] }>();

// Newest first — during a live run the fresh events matter, no scrolling to
// the bottom for them. presentEvents needs the chronological order for the
// report_progress dedup (it pairs an event with its successor), so reverse after.
const items = computed(() => presentEvents(props.events).reverse());
</script>

<template>
  <ul class="timeline" data-test="timeline">
    <TimelineEvent v-for="item in items" :key="item.id" :item="item" />
  </ul>
</template>

<style scoped lang="scss">
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>

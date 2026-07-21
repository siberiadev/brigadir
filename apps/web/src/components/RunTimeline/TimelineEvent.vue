<script setup lang="ts">
/**
 * One run-timeline entry: `time · icon · title (· tags)` with the body shown in
 * full below (feature 026). The body renders as Markdown, a monospace block, or
 * a key/value list depending on `item.bodyFormat`. A very long body is collapsed
 * to a preview with a per-entry "show more/less" control — the full text is
 * always in the DOM, so nothing is truncated (refines the 2026-07-15 decision).
 */
import { computed, ref, type Component } from 'vue';
import {
  Activity,
  CircleDot,
  FlagTriangleRight,
  Info,
  MailWarning,
  Megaphone,
  MessageCircleQuestion,
  PlugZap,
  RotateCcw,
  Ticket,
  TriangleAlert,
  Unplug,
  Wrench,
} from 'lucide-vue-next';
import MarkdownText from '../MarkdownText.vue';
import type { IconKey, TimelineItem } from './presenter';

const props = defineProps<{ item: TimelineItem }>();

// Collapse decision is char/line based (deterministic + testable), not layout —
// jsdom has no real layout. The CSS clamp handles the visual height.
const COLLAPSE_CHAR_THRESHOLD = 800;
const COLLAPSE_LINE_THRESHOLD = 12;

const expanded = ref(false);

const collapsible = computed(() => {
  const body = props.item.body;
  if (!body) return false;
  return body.length > COLLAPSE_CHAR_THRESHOLD || body.split('\n').length > COLLAPSE_LINE_THRESHOLD;
});

const showTruncationNote = computed(() => props.item.legacyTruncated || props.item.fieldTruncated);

const ICONS: Record<IconKey, Component> = {
  tool_call: Wrench,
  progress: Activity,
  log: Info,
  jira_action: Ticket,
  api_retry: RotateCcw,
  error: TriangleAlert,
  unknown: CircleDot,
  // Orchestrator calls to Brigadir — distinct static glyphs (FR-013/FR-017).
  report_progress: Megaphone,
  request_human: MessageCircleQuestion,
  complete_task: FlagTriangleRight,
  // feature 026 durable-finalization safety-net events.
  undelivered_report: MailWarning,
  channel_down: PlugZap,
  // feature 027: доставка callback'а исчерпала ретраи (breadcrumb-событие).
  channel_failure: Unplug,
};

const icon = computed<Component>(() => ICONS[props.item.iconKey] ?? CircleDot);
</script>

<template>
  <li class="event" :class="[`event--${item.typeKey}`, { 'event--orchestrator': item.orchestrator }]">
    <div class="row" :data-test="`event-${item.id}`">
      <span class="time" :title="item.timeTitle">{{ item.time }}</span>
      <span class="node">
        <component :is="icon" :size="13" />
      </span>
      <span class="title">{{ item.title }}</span>
      <span
        v-for="(tag, i) in item.tags"
        :key="i"
        class="tag"
        :class="tag.tone ? `tag--${tag.tone}` : ''"
        >{{ tag.label }}</span
      >
      <span v-if="item.percent != null" class="percent">{{ item.percent }}%</span>
    </div>

    <div v-if="item.body || item.kv" class="body-wrap">
      <div class="body" :class="{ collapsed: collapsible && !expanded }" :data-test="`event-body-${item.id}`">
        <MarkdownText v-if="item.bodyFormat === 'markdown'" :source="item.body" />
        <dl v-else-if="item.bodyFormat === 'kv' && item.kv" class="kv">
          <template v-for="pair in item.kv" :key="pair.key">
            <dt>{{ pair.key }}</dt>
            <dd>{{ pair.value }}</dd>
          </template>
        </dl>
        <pre v-else class="mono">{{ item.body }}</pre>
      </div>
      <button
        v-if="collapsible"
        type="button"
        class="toggle"
        :data-test="`event-toggle-${item.id}`"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Show more' }}
      </button>
      <p v-if="showTruncationNote" class="note" :data-test="`event-note-${item.id}`">
        input truncated by the executor
      </p>
    </div>
  </li>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

$time-width: 62px;
$node-size: 24px;
$rail-x: $time-width + $space-sm + ($node-size / 2);
$body-indent: $time-width + $space-sm + $node-size + $space-sm;

.event {
  position: relative;
  padding-bottom: $space-xs;

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
// feature 026: a rescued verdict on an intentionally-stopped run (warning),
// and a dead-channel hold before spawn (danger — an environment outage).
.event--undelivered_report {
  --type-color: var(--el-color-warning);
}
.event--channel_down {
  --type-color: var(--el-color-danger);
}
// feature 027: клиентская сторона того же отказа — доставка callback'а сдалась.
.event--channel_failure {
  --type-color: var(--el-color-danger);
}
.event--unknown {
  --type-color: var(--el-text-color-secondary);
}
// Orchestrator calls read as a message to Brigadir — tint the node primary.
.event--orchestrator {
  --type-color: var(--el-color-primary);
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
  position: relative;
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

.tag {
  flex: none;
  font-size: 11px;
  line-height: 1.6;
  padding: 0 $space-xs;
  border-radius: $radius-sm;
  color: var(--el-color-info);
  background: var(--el-fill-color);
  &--warning {
    color: var(--el-color-warning);
  }
  &--success {
    color: var(--el-color-success);
  }
}

.percent {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.body-wrap {
  margin: 0 0 $space-xs $body-indent;
}

.body {
  padding: $space-sm;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: $radius-sm;

  &.collapsed {
    max-height: 15em;
    overflow: hidden;
    // Fade the clipped edge so it reads as "there is more".
    mask-image: linear-gradient(to bottom, black 70%, transparent);
  }

  .mono {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
}

.kv {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px $space-sm;

  dt {
    color: var(--el-text-color-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
}

.toggle {
  margin-top: $space-xs;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--el-color-primary);
  &:hover {
    text-decoration: underline;
  }
}

.note {
  margin: $space-xs 0 0;
  font-size: 11px;
  font-style: italic;
  color: var(--el-text-color-secondary);
}
</style>

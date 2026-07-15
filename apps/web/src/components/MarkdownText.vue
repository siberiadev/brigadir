<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../utils/markdown';

/**
 * Renders agent-authored Markdown (human-task `details`) to HTML at runtime.
 * `renderMarkdown` escapes the source first and emits only a safe tag subset,
 * so `v-html` here carries no author-controlled markup (see utils/markdown.ts).
 */
const props = defineProps<{ source: string | null | undefined }>();

const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown (escape-first, curated tags) -->
  <div class="markdown-body" data-test="markdown-body" v-html="html" />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.markdown-body {
  color: var(--el-text-color-regular);
  line-height: 1.55;
  overflow-wrap: anywhere;

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    margin: $space-sm 0 $space-xs;
    font-weight: $font-weight-medium;
    line-height: 1.3;
  }
  :deep(h1) { font-size: 1.25em; }
  :deep(h2) { font-size: 1.15em; }
  :deep(h3) { font-size: 1.05em; }
  :deep(h4),
  :deep(h5),
  :deep(h6) { font-size: 1em; }

  :deep(p) {
    margin: $space-xs 0;
  }

  :deep(ul),
  :deep(ol) {
    margin: $space-xs 0;
    padding-left: 1.4em;
  }
  :deep(li) {
    margin: 2px 0;
  }

  :deep(a) {
    color: var(--el-color-primary);
  }

  :deep(code) {
    font-family: var(--el-font-family-mono, ui-monospace, monospace);
    font-size: 0.9em;
    background: var(--el-fill-color-light);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }

  :deep(pre) {
    margin: $space-xs 0;
    padding: $space-sm;
    background: var(--el-fill-color-light);
    border-radius: 6px;
    overflow-x: auto;

    code {
      background: none;
      padding: 0;
    }
  }

  :deep(blockquote) {
    margin: $space-xs 0;
    padding-left: $space-sm;
    border-left: 3px solid var(--el-border-color);
    color: var(--el-text-color-secondary);
  }

  :deep(hr) {
    border: none;
    border-top: 1px solid var(--el-border-color);
    margin: $space-sm 0;
  }

  :deep(> *:first-child) {
    margin-top: 0;
  }
  :deep(> *:last-child) {
    margin-bottom: 0;
  }
}
</style>

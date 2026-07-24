<script setup lang="ts">
import { computed } from 'vue';

/**
 * Feature 031: read-only env display for one scope (workspace defaults or a
 * repository), shown on the Environment settings panel. A tidy 3-column grid
 * key | value | type. Secret values never leave the server, so they render as a
 * `••••••••` mask — the mask alone signals secret-ness, so there is no tag.
 */
const props = defineProps<{
  /** Non-secret env for this scope. */
  plain: Record<string, string>;
  /** Names of secrets stored for this scope (values never leave the server). */
  secretKeys: string[];
}>();

const MASK = '••••••••';
const plainRows = computed(() => Object.entries(props.plain));
</script>

<template>
  <div class="env-readonly">
    <template v-for="[k, v] in plainRows" :key="`p-${k}`">
      <span class="env-key">{{ k }}</span>
      <span class="env-val">{{ v }}</span>
      <span class="env-type">plain</span>
    </template>
    <template v-for="k in secretKeys" :key="`s-${k}`">
      <span class="env-key">{{ k }}</span>
      <span class="env-val masked">{{ MASK }}</span>
      <span class="env-type">secret</span>
    </template>
  </div>
</template>

<style scoped>
.env-readonly {
  display: grid;
  grid-template-columns: minmax(30%, max-content) 1fr auto;
  gap: 4px 12px;
  align-items: baseline;
  font-size: 13px;
}
.env-key,
.env-val {
  font-family: var(--brigadir-font-mono, monospace);
  overflow-wrap: anywhere;
}
.env-val {
  color: var(--el-text-color-secondary);
}
.masked {
  color: var(--el-text-color-placeholder);
}
.env-type {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
</style>

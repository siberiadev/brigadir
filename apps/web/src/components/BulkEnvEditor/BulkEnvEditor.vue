<script setup lang="ts">
import { computed, ref } from 'vue';
import FormDialog from '../FormDialog.vue';
import { serializeBulkEnv, computeBulkResult, type BulkEnvResult } from './bulk-env';

/**
 * Bulk ".env" editor (feature 031) — a textarea modal to paste/edit the whole
 * env set at once, DigitalOcean App Platform style. Reusable across every env
 * scope (repository, workspace defaults, agent override); all state comes in via
 * props and the result goes out via `apply` — the parent owns persistence.
 *
 * The modal seeds from the current env on open (destroy-on-close re-mounts fresh
 * each time, so the textarea always reflects the latest values). Existing
 * secrets show masked; see bulk-env.ts for the mask/round-trip rules.
 */
const props = defineProps<{
  modelValue: boolean;
  /** Current non-secret env for this scope. */
  plainEnv: Record<string, string>;
  /** Names of existing secrets for this scope (values never leave the server). */
  secretKeys: string[];
  title?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  apply: [result: BulkEnvResult];
}>();

// Seeded once per open — FormDialog's destroy-on-close remounts this component,
// so setup runs fresh each time with the latest props.
const text = ref(serializeBulkEnv(props.plainEnv, props.secretKeys));

const result = computed(() => computeBulkResult(text.value, props.secretKeys));
const errors = computed(() => result.value.errors);

function close() {
  emit('update:modelValue', false);
}
function apply() {
  if (errors.value.length > 0) return;
  emit('apply', result.value);
  close();
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="title ?? 'Add from .env'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="hint">
      Paste or edit <code>KEY=value</code> lines (one per line). Existing secrets show as
      <code>{{ '••••••••' }}</code> — leave them to keep the value, change them to re-seal, delete the
      line to remove. New lines are saved as non-secret.
    </p>
    <el-input
      v-model="text"
      type="textarea"
      class="mono"
      :autosize="{ minRows: 5, maxRows: 30 }"
      spellcheck="false"
      placeholder="DATABASE_URL=postgres://…&#10;PORT=3100"
      data-test="bulk-env-textarea"
    />
    <ul v-if="errors.length" class="errors" data-test="bulk-env-errors">
      <li v-for="(e, i) in errors" :key="i">{{ e.message }}</li>
    </ul>
    <template #footer>
      <el-button data-test="bulk-env-cancel" @click="close">Cancel</el-button>
      <el-button type="primary" :disabled="errors.length > 0" data-test="bulk-env-apply" @click="apply">
        Apply
      </el-button>
    </template>
  </FormDialog>
</template>

<style scoped>
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0 0 10px;
}
.mono :deep(textarea) {
  font-family: var(--brigadir-font-mono, monospace);
  font-size: 13px;
}
.errors {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--el-color-danger);
  font-size: 13px;
}
</style>

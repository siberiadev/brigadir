<script setup lang="ts">
import { computed, reactive } from 'vue';
import { Trash2 } from 'lucide-vue-next';
import { ENV_KEY_REGEX, isReservedEnvKey, envByteLength, ENV_VALUE_MAX_BYTES } from '@brigadir/contracts/env';

/**
 * Feature 031: the shared env-variable editor for one scope (workspace, a
 * repository, or an agent). Every row is a uniform [key][value][secret][remove].
 *
 * Already-saved vars have a DISABLED secret switch — secret-ness is decided when
 * a var is added, not after. A saved secret shows its value as `••••••••` (the
 * value is write-only and never leaves the server). The add row's switch is
 * live: toggling it masks/unmasks the value being typed and marks it secret.
 * Non-secret values edit in place (v-model, saved with the form); secret adds/
 * removes are persisted by the parent through the env-secrets endpoint.
 */
const MASK = '••••••••';

const props = withDefaults(
  defineProps<{
    /** Non-secret env for this scope (v-model). */
    modelValue: Record<string, string>;
    /** Names of secrets stored for this scope (values never leave the server). */
    secretKeys: string[];
    /** Optional: keys resolved from a LOWER layer, for "overrides" badges (US4). */
    inheritedKeys?: string[];
    /**
     * Whether this scope can hold secrets yet. False for a brand-new repo/agent
     * with no id (secrets persist by id) — hides the add row's secret switch so
     * nothing silently no-ops.
     */
    secretsEnabled?: boolean;
  }>(),
  { secretsEnabled: true },
);
const emit = defineEmits<{
  'update:modelValue': [Record<string, string>];
  'add-secret': [key: string, value: string];
  'remove-secret': [key: string];
}>();

const draft = reactive({ key: '', value: '', secret: false });

const plainRows = computed(() => Object.entries(props.modelValue));

function keyError(key: string): string | null {
  if (!key) return null;
  if (!ENV_KEY_REGEX.test(key)) return 'Invalid name (use A–Z, 0–9, _ and not starting with a digit).';
  if (isReservedEnvKey(key)) return `"${key}" is reserved by the platform.`;
  if (key in props.modelValue) return 'Key already set as a plain value.';
  if (props.secretKeys.includes(key)) return 'Key already set as a secret.';
  return null;
}
const draftError = computed(() => keyError(draft.key));
const valueTooBig = computed(() => envByteLength(draft.value) > ENV_VALUE_MAX_BYTES);
const canAdd = computed(() => !!draft.key && !draftError.value && !valueTooBig.value);

function overrides(key: string): boolean {
  return (props.inheritedKeys ?? []).includes(key);
}

function updatePlainValue(key: string, value: string) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}
function removePlain(key: string) {
  const next = { ...props.modelValue };
  delete next[key];
  emit('update:modelValue', next);
}
function add() {
  if (!canAdd.value) return;
  if (draft.secret) emit('add-secret', draft.key, draft.value);
  else emit('update:modelValue', { ...props.modelValue, [draft.key]: draft.value });
  draft.key = '';
  draft.value = '';
  draft.secret = false;
}
</script>

<template>
  <div class="env-vars-table" data-test="env-vars-table">
    <div v-if="plainRows.length || secretKeys.length" class="rows">
      <!-- saved non-secret vars -->
      <div v-for="[key, value] in plainRows" :key="`p-${key}`" class="row" :data-test="`env-plain-${key}`">
        <div class="key-cell">
          <el-input :model-value="key" disabled size="small" class="mono" />
          <el-tag v-if="overrides(key)" size="small" type="info" data-test="env-override-badge">overrides</el-tag>
        </div>
        <el-input
          :model-value="value"
          size="small"
          class="mono val"
          :data-test="`env-plain-value-${key}`"
          @update:model-value="(v: string) => updatePlainValue(key, v)"
        />
        <el-switch :model-value="false" disabled size="small" class="toggle" :data-test="`env-plain-secret-${key}`" />
        <el-button
          link
          size="small"
          class="remove"
          aria-label="Remove variable"
          :data-test="`env-plain-remove-${key}`"
          @click="removePlain(key)"
        >
          <Trash2 :size="16" />
        </el-button>
      </div>

      <!-- saved secret vars (value never leaves the server → shown masked) -->
      <div v-for="key in secretKeys" :key="`s-${key}`" class="row" :data-test="`env-secret-${key}`">
        <div class="key-cell">
          <el-input :model-value="key" disabled size="small" class="mono" />
          <el-tag v-if="overrides(key)" size="small" type="info">overrides</el-tag>
        </div>
        <el-input :model-value="MASK" disabled size="small" class="mono val" :data-test="`env-secret-value-${key}`" />
        <el-switch :model-value="true" disabled size="small" class="toggle" :data-test="`env-secret-toggle-${key}`" />
        <el-button
          link
          size="small"
          class="remove"
          aria-label="Remove variable"
          :data-test="`env-secret-remove-${key}`"
          @click="emit('remove-secret', key)"
        >
          <Trash2 :size="16" />
        </el-button>
      </div>
    </div>
    <p v-else class="empty">No environment variables.</p>

    <!-- add row: the only place secret-ness is chosen (mask/unmask live) -->
    <div class="row add-row">
      <el-input v-model="draft.key" placeholder="KEY" size="small" class="mono key-cell" data-test="env-add-key" />
      <el-input
        v-model="draft.value"
        :type="draft.secret ? 'password' : 'text'"
        :placeholder="draft.secret ? 'secret value' : 'value'"
        size="small"
        class="mono val"
        data-test="env-add-value"
      />
      <el-switch
        v-if="secretsEnabled"
        v-model="draft.secret"
        size="small"
        class="toggle"
        data-test="env-add-secret-flag"
      />
      <span v-else class="toggle" />
      <el-button size="small" :disabled="!canAdd" data-test="env-add" @click="add">Add</el-button>
    </div>
    <p v-if="draftError" class="err" data-test="env-add-error">{{ draftError }}</p>
    <p v-else-if="valueTooBig" class="err" data-test="env-add-error">Value is too large (max 8 KB).</p>
  </div>
</template>

<style scoped>
.env-vars-table {
  font-size: 13px;
}
.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.add-row {
  border-bottom: none;
  margin-top: 6px;
}
.key-cell {
  width: 32%;
  display: flex;
  align-items: center;
  gap: 6px;
}
.val {
  flex: 1;
}
.toggle {
  width: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  justify-content: center;
}
.mono :deep(input) {
  font-family: var(--brigadir-font-mono, monospace);
}
.remove {
  color: var(--el-text-color-secondary);
}
.remove:hover {
  color: var(--el-color-danger);
}
.empty {
  color: var(--el-text-color-secondary);
  margin: 4px 0;
}
.err {
  color: var(--el-color-danger);
  margin: 6px 0 0;
}
</style>

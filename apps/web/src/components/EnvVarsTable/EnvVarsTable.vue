<script setup lang="ts">
import { computed, reactive } from 'vue';
import { ENV_KEY_REGEX, isReservedEnvKey, envByteLength, ENV_VALUE_MAX_BYTES } from '@brigadir/contracts/env';

/**
 * Feature 031: the shared env-variable editor for one scope (workspace, a
 * repository, or an agent). Non-secret rows are edited in place and travel with
 * the parent form's save (v-model). Secret rows are WRITE-ONLY: shown masked
 * (name only), added/removed via events the parent persists immediately through
 * the env-secrets endpoint — there is no reveal affordance anywhere.
 *
 * Key validation (format + reserved) uses the SAME dep-free rules as the server
 * so an invalid/reserved key is caught inline before any request.
 */
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
     * that has no id (secrets persist by id) — hides the secret toggle and the
     * per-row "Make secret" action so nothing silently no-ops.
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

function keyError(key: string, { existing = false } = {}): string | null {
  if (!key) return null;
  if (!ENV_KEY_REGEX.test(key)) return 'Invalid name (use A–Z, 0–9, _ and not starting with a digit).';
  if (isReservedEnvKey(key)) return `"${key}" is reserved by the platform.`;
  if (!existing) {
    if (key in props.modelValue) return 'Key already set as a plain value.';
    if (props.secretKeys.includes(key)) return 'Key already set as a secret.';
  }
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
/** Convert an existing non-secret row into a secret (seal via the parent). */
function makeSecret(key: string) {
  const value = props.modelValue[key];
  removePlain(key); // drop from the plaintext model...
  emit('add-secret', key, value); // ...and let the parent seal it (env-secrets)
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
    <table v-if="plainRows.length || secretKeys.length" class="rows">
      <tr v-for="[key, value] in plainRows" :key="`p-${key}`" :data-test="`env-plain-${key}`">
        <td class="key mono">
          {{ key }}
          <el-tag v-if="overrides(key)" size="small" type="info" data-test="env-override-badge">overrides</el-tag>
        </td>
        <td class="value">
          <el-input
            :model-value="value"
            size="small"
            class="mono"
            :data-test="`env-plain-value-${key}`"
            @update:model-value="(v: string) => updatePlainValue(key, v)"
          />
        </td>
        <td class="actions">
          <el-button
            v-if="secretsEnabled"
            link
            size="small"
            :data-test="`env-plain-make-secret-${key}`"
            @click="makeSecret(key)"
          >
            Make secret
          </el-button>
          <el-button link size="small" :data-test="`env-plain-remove-${key}`" @click="removePlain(key)">
            Remove
          </el-button>
        </td>
      </tr>
      <tr v-for="key in secretKeys" :key="`s-${key}`" :data-test="`env-secret-${key}`">
        <td class="key mono">
          {{ key }}
          <el-tag v-if="overrides(key)" size="small" type="info">overrides</el-tag>
        </td>
        <td class="value">
          <span class="masked mono">••••••••</span>
          <el-tag size="small" type="warning" data-test="env-secret-badge">secret</el-tag>
        </td>
        <td class="actions">
          <el-button
            link
            size="small"
            :data-test="`env-secret-remove-${key}`"
            @click="emit('remove-secret', key)"
          >
            Remove
          </el-button>
        </td>
      </tr>
    </table>
    <p v-else class="empty">No environment variables.</p>

    <div class="add-row">
      <el-input v-model="draft.key" placeholder="KEY" size="small" class="mono add-key" data-test="env-add-key" />
      <el-input
        v-model="draft.value"
        :placeholder="draft.secret ? 'secret value' : 'value'"
        size="small"
        class="mono add-value"
        :type="draft.secret ? 'password' : 'text'"
        data-test="env-add-value"
      />
      <label v-if="secretsEnabled" class="secret-toggle">
        <el-switch v-model="draft.secret" size="small" data-test="env-add-secret-flag" />
        <span>secret</span>
      </label>
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
  width: 100%;
  border-collapse: collapse;
}
.rows td {
  padding: 4px 6px 4px 0;
  vertical-align: middle;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.key {
  width: 34%;
  white-space: nowrap;
}
.mono {
  font-family: var(--brigadir-font-mono, monospace);
}
.masked {
  color: var(--el-text-color-secondary);
  margin-right: 6px;
}
.empty {
  color: var(--el-text-color-secondary);
  margin: 4px 0;
}
.add-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.add-key {
  width: 34%;
}
.add-value {
  flex: 1;
}
.secret-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.err {
  color: var(--el-color-danger);
  margin: 6px 0 0;
}
</style>

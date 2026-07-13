<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Info } from 'lucide-vue-next';
import type { ExecutorCreateRequest, ExecutorResponse, ExecutorType } from '@brigadir/contracts';
import { useCreateExecutor, useUpdateExecutor } from '../../composables/useExecutors';
import { ApiError } from '../../api/client';

// Named runner profile form (2026-07-14; platform-scoped since 2026-07-13):
// an executor is a runtime profile — transport type + model + limits +
// optional credentials. Field order: Type → Model (claude_cli) → Name → rest.
// The API key is WRITE-ONLY: the server only ever reports `has_api_key`, so
// the field is a password input with three states — empty ("host
// subscription"), configured (Replace/Clear), replacing (new value pending).
// Driven by the shared `executor.schema` union — the field set switches on
// `type` (mock: Name + Max parallel runs only). Mirrors AgentForm: a
// dialog-agnostic body exposing submit()/saving for the hosting FormDialog.
const props = defineProps<{
  executor?: ExecutorResponse | null;
}>();
const emit = defineEmits<{ saved: [] }>();

const e = props.executor;
const cfg = (e?.config ?? {}) as Record<string, unknown>;

const form = reactive({
  type: (e?.type ?? 'claude_cli') as ExecutorType,
  name: e?.name ?? '',
  max_parallel_runs: e?.max_parallel_runs ?? 1,
  // claude_cli fields
  model: (cfg.model as string | undefined) ?? 'claude-sonnet-5',
  cli_path: (cfg.cli_path as string | undefined) ?? 'claude',
  use_callback_channel: (cfg.use_callback_channel as boolean | undefined) ?? true,
  keep_failed_worktrees: (cfg.keep_failed_worktrees as boolean | undefined) ?? false,
  max_turns: (cfg.max_turns as number | undefined) ?? 30,
  // api_key tri-state mirror: '' + !replacing + !cleared → omit (keep stored).
  api_key: '',
});

const NAME_TIP =
  'An alias for quick recognition of this runner — e.g. the team it belongs to or the user who created it.';

// --- api_key states (write-only round-trip) ---
const hasStoredKey = computed(() => props.executor?.has_api_key === true);
/** true while the operator is entering a NEW key over a stored one. */
const replacingKey = ref(false);
/** true after "Clear" — the save sends api_key: null. */
const clearedKey = ref(false);

function startReplaceKey() {
  replacingKey.value = true;
  clearedKey.value = false;
  form.api_key = '';
}
function clearKey() {
  clearedKey.value = true;
  replacingKey.value = false;
  form.api_key = '';
}

const fieldErrors = reactive<Record<string, string>>({});
const generalError = ref('');

const create = useCreateExecutor();
const update = useUpdateExecutor();
const saving = computed(() => create.isPending.value || update.isPending.value);

function buildRequest(): ExecutorCreateRequest {
  if (form.type === 'mock') {
    return { type: 'mock', name: form.name, max_parallel_runs: form.max_parallel_runs };
  }
  // api_key: entered value → replace; Clear → null; untouched → omitted (keep).
  const apiKeyField = form.api_key
    ? { api_key: form.api_key }
    : clearedKey.value && hasStoredKey.value
      ? { api_key: null }
      : {};
  return {
    type: 'claude_cli',
    name: form.name,
    model: form.model,
    cli_path: form.cli_path,
    use_callback_channel: form.use_callback_channel,
    keep_failed_worktrees: form.keep_failed_worktrees,
    max_turns: form.max_turns,
    max_parallel_runs: form.max_parallel_runs,
    ...apiKeyField,
  };
}

async function submit() {
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
  generalError.value = '';
  const body = buildRequest();
  try {
    if (props.executor) {
      await update.mutateAsync({ id: props.executor.id, body });
    } else {
      await create.mutateAsync(body);
    }
    emit('saved');
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) {
      for (const issue of err.issues) fieldErrors[String(issue.path[0])] = issue.message;
      if (!err.issues.some((i) => i.path.length)) generalError.value = err.message;
    } else if (err instanceof ApiError) {
      generalError.value = err.message;
    } else {
      generalError.value = (err as Error)?.message ?? 'Save failed.';
    }
  }
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="executor-form">
    <div class="two-col">
      <el-form-item label="Type">
        <el-select v-model="form.type" data-test="executor-type">
          <el-option label="claude_cli" value="claude_cli" />
          <el-option label="mock" value="mock" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="form.type === 'claude_cli'" label="Model" :error="fieldErrors.model">
        <el-input v-model="form.model" data-test="executor-model" />
      </el-form-item>
    </div>

    <el-form-item :error="fieldErrors.name">
      <template #label>
        <span class="label-with-tip">
          Name
          <el-tooltip :content="NAME_TIP" placement="right">
            <Info class="tip-icon" data-test="executor-name-tip" />
          </el-tooltip>
        </span>
      </template>
      <el-input v-model="form.name" data-test="executor-name" />
    </el-form-item>

    <!-- claude_cli-only fields -->
    <template v-if="form.type === 'claude_cli'">
      <el-form-item label="CLI path" :error="fieldErrors.cli_path">
        <el-input v-model="form.cli_path" data-test="executor-cli-path" />
      </el-form-item>

      <el-form-item label="API key" :error="fieldErrors.api_key">
        <!-- configured + not replacing/clearing → status line with actions -->
        <div v-if="hasStoredKey && !replacingKey && !clearedKey" class="api-key-configured">
          <el-tag size="small" type="success" data-test="api-key-configured">configured</el-tag>
          <el-button link type="primary" data-test="api-key-replace" @click="startReplaceKey">
            Replace
          </el-button>
          <el-button link type="danger" data-test="api-key-clear" @click="clearKey">
            Clear
          </el-button>
        </div>
        <el-input
          v-else
          v-model="form.api_key"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="host subscription"
          data-test="executor-api-key"
        />
        <div v-if="clearedKey" class="api-key-note" data-test="api-key-cleared-note">
          Key will be removed on save — runs bill to the host subscription.
        </div>
      </el-form-item>

      <div class="two-col">
        <el-form-item label="Max turns">
          <el-input-number v-model="form.max_turns" :min="1" data-test="executor-max-turns" />
        </el-form-item>
        <el-form-item label="Max parallel runs">
          <el-input-number v-model="form.max_parallel_runs" :min="1" data-test="executor-max-parallel" />
        </el-form-item>
      </div>

      <el-form-item label="Use callback channel">
        <el-switch v-model="form.use_callback_channel" data-test="executor-callback" />
      </el-form-item>
      <el-form-item label="Keep failed worktrees">
        <el-switch v-model="form.keep_failed_worktrees" data-test="executor-keep-worktrees" />
      </el-form-item>
    </template>

    <!-- mock-only fields -->
    <template v-else>
      <el-form-item label="Max parallel runs">
        <el-input-number v-model="form.max_parallel_runs" :min="1" data-test="executor-max-parallel" />
      </el-form-item>
    </template>

    <el-alert v-if="generalError" type="error" :closable="false" data-test="executor-error">
      {{ generalError }}
    </el-alert>
  </el-form>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.executor-form {
  max-width: 640px;
}
.two-col {
  display: flex;
  gap: $space-lg;
}
.two-col > * {
  flex: 1;
}
.label-with-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.tip-icon {
  width: 14px;
  height: 14px;
  color: var(--el-text-color-secondary);
  cursor: help;
}
.api-key-configured {
  display: flex;
  align-items: center;
  gap: 8px;
}
.api-key-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>

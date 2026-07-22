<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Info } from 'lucide-vue-next';
import type { ExecutorCreateRequest, ExecutorResponse, ExecutorType } from '@brigadir/contracts';
// RUNTIME values from contracts ride the dep-free source alias, never the CJS
// barrel (rollup can't trace `export *` there) — same rule as pagination.
import {
  isApiKeyOnlyExecutorType,
  isCliHarnessApiExecutorType,
} from '@brigadir/contracts/executor-type-sets';
import { useCreateExecutor, useUpdateExecutor } from '../../composables/useExecutors';
import { ApiError } from '../../api/client';

// Named runner profile form (2026-07-14; platform-scoped since 2026-07-13):
// an executor is a runtime profile — transport type + model + limits +
// optional credentials. Field order: Type → Model (claude_cli) → Name → rest.
// The API key is WRITE-ONLY: the server only ever reports `has_api_key`, so
// the field is a password input with three states — empty, configured
// (Replace/Clear), replacing (new value pending).
// Feature 018: an auth-mode selector gates the per-mode fields — the key
// block only for auth "api_key", the bedrock trio (region / AWS profile /
// CA bundle) only for auth "bedrock". `config.auth` in responses is always
// the EFFECTIVE mode, so the selector prefills correctly for legacy rows.
// Feature 025: `kimi` shares the harness field set (model / CLI path / key /
// knobs) but has NO auth selector (implicitly api_key-only), no AWS fields,
// and deliberately no URL field — the Moonshot endpoint is fixed by the
// type. The key is REQUIRED (create) and can be replaced but never cleared.
// Driven by the shared `executor.schema` union — the field set switches on
// `type` (mock: Name + Max parallel runs only). Mirrors AgentForm: a
// dialog-agnostic body exposing submit()/saving for the hosting FormDialog.
const props = defineProps<{
  executor?: ExecutorResponse | null;
}>();
const emit = defineEmits<{ saved: [] }>();

const e = props.executor;
const cfg = (e?.config ?? {}) as Record<string, unknown>;

type AuthMode = 'host_subscription' | 'api_key' | 'bedrock';

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
  // Feature 018 — auth mode. The response carries the effective mode; the
  // has_api_key fallback covers only a stale client cache.
  auth: ((cfg.auth as AuthMode | undefined) ??
    (e?.has_api_key ? 'api_key' : 'host_subscription')) as AuthMode,
  aws_region: (cfg.aws_region as string | undefined) ?? '',
  aws_profile: (cfg.aws_profile as string | undefined) ?? '',
  ca_bundle_path: (cfg.ca_bundle_path as string | undefined) ?? '',
  // api_key tri-state mirror: '' + !replacing + !cleared → omit (keep stored).
  api_key: '',
});

const NAME_TIP =
  'An alias for quick recognition of this runner — e.g. the team it belongs to or the user who created it.';

// Features 025/028: the types sharing the Claude CLI harness field set —
// membership comes from the shared contracts constants (FR-016), so a fourth
// provider preset extends the constant, not this file.
const isCliHarness = computed(() => isCliHarnessApiExecutorType(form.type));
// The api_key-only preset types (kimi, deepseek_api) show the key block
// unconditionally; claude_cli gates it behind the auth selector.
const isApiKeyOnly = computed(() => isApiKeyOnlyExecutorType(form.type));
const showApiKey = computed(
  () => isApiKeyOnly.value || (form.type === 'claude_cli' && form.auth === 'api_key'),
);

const BEDROCK_MODEL_HINT =
  'Use a full Bedrock model/inference-profile id, e.g. "eu.anthropic.claude-opus-4-8" — bare aliases like "opus" resolve through ANTHROPIC_DEFAULT_*_MODEL env vars that are deliberately not passed to runs.';

const KIMI_MODEL_HINT =
  'A Moonshot model id, e.g. "kimi-k3" or a "kimi-k2.7" variant. Runs execute against Moonshot’s Anthropic-compatible endpoint; cost figures are priced against Anthropic’s list and are indicative only.';

const DEEPSEEK_MODEL_HINT =
  'A NATIVE DeepSeek model id: "deepseek-v4-pro" or "deepseek-v4-flash". Caution: unrecognized names are silently routed by DeepSeek to its cheapest model — no error is raised. Runs execute against DeepSeek’s Anthropic-compatible endpoint; cost figures are priced against Anthropic’s list and are indicative only.';

/** Operator-facing provider name for the api_key-only types' key-required message. */
const API_KEY_PROVIDER_LABELS: Record<'kimi' | 'deepseek_api', string> = {
  kimi: 'Moonshot',
  deepseek_api: 'DeepSeek',
};

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
  if (form.type === 'kimi' || form.type === 'deepseek_api') {
    // Features 025/028 (api_key-only presets): no auth selector, no AWS
    // fields, no URL — harness knobs + the write-only key only. An entered
    // key rides along; untouched → omit (keep stored). There is no Clear
    // path: a keyless profile of these types cannot exist, so
    // `api_key: null` is never sent.
    const harness = {
      name: form.name,
      model: form.model,
      cli_path: form.cli_path,
      use_callback_channel: form.use_callback_channel,
      keep_failed_worktrees: form.keep_failed_worktrees,
      max_turns: form.max_turns,
      max_parallel_runs: form.max_parallel_runs,
      ...(form.api_key ? { api_key: form.api_key } : {}),
    };
    return form.type === 'kimi'
      ? { type: 'kimi', ...harness }
      : { type: 'deepseek_api', ...harness };
  }
  // api_key tri-state applies only in api_key mode: entered value → replace;
  // Clear → null; untouched → omitted (keep). Other modes send NO api_key —
  // switching away from api_key leaves the stored blob inert (contract:
  // executor-auth.md, FR-009).
  const apiKeyField =
    form.auth === 'api_key'
      ? form.api_key
        ? { api_key: form.api_key }
        : clearedKey.value && hasStoredKey.value
          ? { api_key: null }
          : {}
      : {};
  // Bedrock fields ride only in bedrock mode, optional ones only when filled.
  const bedrockFields =
    form.auth === 'bedrock'
      ? {
          aws_region: form.aws_region,
          ...(form.aws_profile ? { aws_profile: form.aws_profile } : {}),
          ...(form.ca_bundle_path ? { ca_bundle_path: form.ca_bundle_path } : {}),
        }
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
    auth: form.auth,
    ...bedrockFields,
    ...apiKeyField,
  };
}

async function submit() {
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
  generalError.value = '';
  // Features 025/028: a new api_key-only profile must arrive with a key
  // (schema rule '<type> requires an api_key on create') — surface it before
  // the round-trip.
  if ((form.type === 'kimi' || form.type === 'deepseek_api') && !props.executor && !form.api_key) {
    fieldErrors.api_key = `A ${API_KEY_PROVIDER_LABELS[form.type]} API key is required to create a ${form.type} profile.`;
    return;
  }
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
          <el-option label="kimi" value="kimi" />
          <el-option label="deepseek_api" value="deepseek_api" />
          <el-option label="mock" value="mock" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="isCliHarness" label="Model" :error="fieldErrors.model">
        <el-input v-model="form.model" data-test="executor-model" />
        <div
          v-if="form.type === 'claude_cli' && form.auth === 'bedrock'"
          class="field-hint"
          data-test="bedrock-model-hint"
        >
          {{ BEDROCK_MODEL_HINT }}
        </div>
        <div v-else-if="form.type === 'kimi'" class="field-hint" data-test="kimi-model-hint">
          {{ KIMI_MODEL_HINT }}
        </div>
        <div
          v-else-if="form.type === 'deepseek_api'"
          class="field-hint"
          data-test="deepseek-model-hint"
        >
          {{ DEEPSEEK_MODEL_HINT }}
        </div>
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

    <!-- claude_cli + kimi + deepseek_api share the Claude CLI harness field set (features 025/028) -->
    <template v-if="isCliHarness">
      <el-form-item label="CLI path" :error="fieldErrors.cli_path">
        <el-input v-model="form.cli_path" data-test="executor-cli-path" />
      </el-form-item>

      <!-- Auth mode selector is claude_cli-only: kimi/deepseek_api are implicitly api_key-only -->
      <el-form-item v-if="form.type === 'claude_cli'" label="Authentication" :error="fieldErrors.auth">
        <el-select v-model="form.auth" data-test="executor-auth">
          <el-option label="Host subscription (~/.claude)" value="host_subscription" />
          <el-option label="API key" value="api_key" />
          <el-option label="AWS Bedrock" value="bedrock" />
        </el-select>
      </el-form-item>

      <!-- API key: claude_cli api_key mode (tri-state) OR kimi (required, no Clear) -->
      <el-form-item v-if="showApiKey" label="API key" :error="fieldErrors.api_key">
        <!-- configured + not replacing/clearing → status line with actions -->
        <div v-if="hasStoredKey && !replacingKey && !clearedKey" class="api-key-configured">
          <el-tag size="small" type="success" data-test="api-key-configured">configured</el-tag>
          <el-button link type="primary" data-test="api-key-replace" @click="startReplaceKey">
            Replace
          </el-button>
          <!-- api_key-only types (kimi, deepseek_api) cannot be cleared: a keyless profile can never run -->
          <el-button
            v-if="!isApiKeyOnly"
            link
            type="danger"
            data-test="api-key-clear"
            @click="clearKey"
          >
            Clear
          </el-button>
        </div>
        <el-input
          v-else
          v-model="form.api_key"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="isApiKeyOnly ? 'sk-...' : 'sk-ant-...'"
          data-test="executor-api-key"
        />
        <div v-if="clearedKey" class="api-key-note" data-test="api-key-cleared-note">
          Key will be removed on save — runs bill to the host subscription.
        </div>
      </el-form-item>

      <!-- bedrock mode only (claude_cli): non-secret AWS settings; credentials stay in ~/.aws on the worker -->
      <template v-if="form.type === 'claude_cli' && form.auth === 'bedrock'">
        <el-form-item label="AWS region" :error="fieldErrors.aws_region">
          <el-input v-model="form.aws_region" placeholder="eu-west-1" data-test="executor-aws-region" />
        </el-form-item>
        <div class="two-col">
          <el-form-item :error="fieldErrors.aws_profile">
            <template #label>
              <span class="label-with-tip">
                AWS profile
                <el-tooltip
                  content="Named profile from ~/.aws on the worker host. Leave empty to use the AWS default credential chain."
                  placement="right"
                >
                  <Info class="tip-icon" />
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.aws_profile" placeholder="default chain" data-test="executor-aws-profile" />
          </el-form-item>
          <el-form-item :error="fieldErrors.ca_bundle_path">
            <template #label>
              <span class="label-with-tip">
                CA bundle path
                <el-tooltip
                  content="Corporate TLS-interception bundle on the worker host (injected as NODE_EXTRA_CA_CERTS). Leave empty if not intercepted."
                  placement="right"
                >
                  <Info class="tip-icon" />
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.ca_bundle_path" placeholder="/etc/ssl/corp/ca.pem" data-test="executor-ca-bundle" />
          </el-form-item>
        </div>
      </template>

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
.field-hint {
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>

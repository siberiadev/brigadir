<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EnvSecretKeys } from '@brigadir/contracts';
import { useUpdateSettings, useUpdateEnvSecrets } from '../../composables/useWorkspaces';
import EnvVarsTable from '../EnvVarsTable/EnvVarsTable.vue';
import BulkEnvEditor from '../BulkEnvEditor/BulkEnvEditor.vue';
import type { BulkEnvResult } from '../BulkEnvEditor/bulk-env';

/**
 * Workspace-level environment defaults editor (feature 031 settings restructure).
 * Only the workspace `env` defaults — repositories are edited one-at-a-time in
 * RepositoryForm. Non-secret vars save with the form (settings PATCH of `env`);
 * secret vars are write-only and persist immediately via the env-secrets
 * endpoint (scope: workspace). Exposes `submit()`/`saving`, emits `saved`.
 */
const props = defineProps<{
  workspaceId: string;
  env?: Record<string, string>;
  envSecretKeys?: EnvSecretKeys;
}>();
const emit = defineEmits<{ saved: [] }>();

const wsEnv = ref<Record<string, string>>({ ...(props.env ?? {}) });
const secretKeys = ref<string[]>(props.envSecretKeys?.workspace ?? []);
// Plain keys the user flipped to secret in the table — sealed on Save (below).
const promoteKeys = ref<string[]>([]);
const envError = ref('');

const updateSettings = useUpdateSettings(props.workspaceId);
const envSecrets = useUpdateEnvSecrets(props.workspaceId);
const saving = computed(() => updateSettings.isPending.value);

function addSecret(key: string, value: string) {
  void envSecrets
    .mutateAsync({ scope: 'workspace', set: { [key]: value } })
    .then((res) => (secretKeys.value = res.env_secret_keys.workspace));
}
function removeSecret(key: string) {
  void envSecrets
    .mutateAsync({ scope: 'workspace', delete: [key] })
    .then((res) => (secretKeys.value = res.env_secret_keys.workspace));
}

async function submit() {
  envError.value = '';
  // Drop promoted keys from plaintext FIRST (settings PUT), then seal them — the
  // only order the backend's "one home per key" guards accept. Never mutate
  // wsEnv here, so a failed seal is retry-safe (the value is still local).
  const plain = { ...wsEnv.value };
  for (const k of promoteKeys.value) delete plain[k];
  await updateSettings.mutateAsync({ env: plain });
  if (promoteKeys.value.length) {
    try {
      const set = Object.fromEntries(promoteKeys.value.map((k) => [k, wsEnv.value[k]]));
      const res = await envSecrets.mutateAsync({ scope: 'workspace', set });
      secretKeys.value = res.env_secret_keys.workspace;
    } catch {
      envError.value = 'Defaults saved, but sealing secrets failed — retry.';
      return; // keep the modal open; retry re-runs both calls safely
    }
  }
  emit('saved');
}

// --- bulk ".env" editor ---
const showBulk = ref(false);
function onBulkApply({ plainEnv, secretSet, secretDelete }: BulkEnvResult) {
  wsEnv.value = plainEnv; // replace non-secret env (saved with the form)
  const set = Object.keys(secretSet).length ? secretSet : undefined;
  const del = secretDelete.length ? secretDelete : undefined;
  if (set || del) {
    void envSecrets
      .mutateAsync({ scope: 'workspace', set, delete: del })
      .then((res) => (secretKeys.value = res.env_secret_keys.workspace));
  }
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="workspace-env-form">
    <div class="env-head">
      <p class="env-hint" data-test="env-defaults-hint">
        Injected into every repo-mounted run. Applies to new runs, not runs already in progress.
      </p>
      <el-button size="small" data-test="ws-bulk-env" @click="showBulk = true">Add from .env</el-button>
    </div>
    <EnvVarsTable
      v-model="wsEnv"
      v-model:promote-keys="promoteKeys"
      :secret-keys="secretKeys"
      data-test="ws-env"
      @add-secret="addSecret"
      @remove-secret="removeSecret"
    />
    <p v-if="envError" class="err" data-test="ws-env-error">{{ envError }}</p>

    <BulkEnvEditor v-model="showBulk" :plain-env="wsEnv" :secret-keys="secretKeys" @apply="onBulkApply" />
  </el-form>
</template>

<style scoped lang="scss">
.workspace-env-form {
  max-width: 640px;
}
.env-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}
.env-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 2px 0 8px;
}
.err {
  color: var(--el-color-danger);
  font-size: 13px;
  margin: 8px 0 0;
}
</style>

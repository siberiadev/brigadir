<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EnvSecretKeys } from '@brigadir/contracts';
import { useUpdateSettings, useUpdateEnvSecrets } from '../../composables/useWorkspaces';
import EnvVarsTable from '../EnvVarsTable/EnvVarsTable.vue';

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
  await updateSettings.mutateAsync({ env: wsEnv.value });
  emit('saved');
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="workspace-env-form">
    <p class="env-hint" data-test="env-defaults-hint">
      Injected into every repo-mounted run. Applies to new runs, not runs already in progress.
    </p>
    <EnvVarsTable
      v-model="wsEnv"
      :secret-keys="secretKeys"
      data-test="ws-env"
      @add-secret="addSecret"
      @remove-secret="removeSecret"
    />
  </el-form>
</template>

<style scoped lang="scss">
.workspace-env-form {
  max-width: 640px;
}
.env-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 2px 0 8px;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkspaceRepository, EnvSecretKeys, EnvSecretScope } from '@brigadir/contracts';
import { useUpdateSettings, useUpdateEnvSecrets } from '../../composables/useWorkspaces';
import EnvVarsTable from '../EnvVarsTable/EnvVarsTable.vue';

/**
 * Environment form (feature 031) — the ordered repository list (first = default)
 * plus non-secret workspace env defaults and per-repo env. Split out of the old
 * ConfigForm when the workspace Settings page moved to sidebar sections.
 *
 * Non-secret env + repositories are edited in place and saved together (PATCH of
 * settings jsonb — branch/scope untouched). Secret env is WRITE-ONLY and
 * persisted IMMEDIATELY through the env-secrets endpoint (masked, replace/delete
 * only). Exposes `submit()`/`saving`, emits `saved`.
 */
const props = defineProps<{
  workspaceId: string;
  repositories: WorkspaceRepository[];
  env?: Record<string, string>;
  envSecretKeys?: EnvSecretKeys;
}>();
const emit = defineEmits<{ saved: [] }>();

type EditableRepo = WorkspaceRepository & { env: Record<string, string> };
const repositories = ref<EditableRepo[]>(
  props.repositories.map((r) => ({ ...r, env: { ...(r.env ?? {}) } })),
);
const wsEnv = ref<Record<string, string>>({ ...(props.env ?? {}) });
const secretKeys = ref<EnvSecretKeys>(props.envSecretKeys ?? { workspace: [], repos: {}, agents: {} });

const updateSettings = useUpdateSettings(props.workspaceId);
const envSecrets = useUpdateEnvSecrets(props.workspaceId);
const saving = computed(() => updateSettings.isPending.value);

async function writeSecret(scope: EnvSecretScope, op: { set?: Record<string, string>; delete?: string[] }) {
  const res = await envSecrets.mutateAsync({ scope, ...op });
  secretKeys.value = res.env_secret_keys;
}
function addWorkspaceSecret(key: string, value: string) {
  void writeSecret('workspace', { set: { [key]: value } });
}
function removeWorkspaceSecret(key: string) {
  void writeSecret('workspace', { delete: [key] });
}
function addRepoSecret(repo: WorkspaceRepository, key: string, value: string) {
  if (!repo.id) return; // a brand-new repo must be saved first (gets an id)
  void writeSecret({ repository_id: repo.id }, { set: { [key]: value } });
}
function removeRepoSecret(repo: WorkspaceRepository, key: string) {
  if (!repo.id) return;
  void writeSecret({ repository_id: repo.id }, { delete: [key] });
}
function repoSecretKeys(repo: WorkspaceRepository): string[] {
  return repo.id ? (secretKeys.value.repos[repo.id] ?? []) : [];
}

function addRepository() {
  repositories.value.push({ name: '', git_url: '', default_branch: 'main', env: {} });
}
function removeRepository(index: number) {
  repositories.value.splice(index, 1);
}

async function submit() {
  const repos = repositories.value
    .filter((r) => r.name && r.git_url && r.default_branch)
    .map((r) => ({ ...r, env: Object.keys(r.env ?? {}).length ? r.env : undefined }));
  await updateSettings.mutateAsync({
    repositories: repos,
    env: wsEnv.value,
  });
  emit('saved');
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="environment-form">
    <h4>Environment defaults</h4>
    <p class="env-hint" data-test="env-defaults-hint">
      Injected into every repo-mounted run. Applies to new runs, not runs already in progress.
    </p>
    <EnvVarsTable
      v-model="wsEnv"
      :secret-keys="secretKeys.workspace"
      data-test="ws-env"
      @add-secret="addWorkspaceSecret"
      @remove-secret="removeWorkspaceSecret"
    />

    <h4>Repositories (first = default)</h4>
    <div v-for="(repo, i) in repositories" :key="i" class="repo-block" :data-test="`repo-row-${i}`">
      <div class="repo-row">
        <el-input v-model="repo.name" placeholder="name" :data-test="`repo-name-${i}`" />
        <el-input v-model="repo.git_url" placeholder="git@…" :data-test="`repo-url-${i}`" />
        <el-input v-model="repo.default_branch" placeholder="main" :data-test="`repo-branch-${i}`" />
        <el-button link type="danger" :data-test="`repo-remove-${i}`" @click="removeRepository(i)">
          Remove
        </el-button>
      </div>
      <div class="repo-env">
        <span class="repo-env-label">Environment</span>
        <EnvVarsTable
          v-model="repo.env"
          :secret-keys="repoSecretKeys(repo)"
          :inherited-keys="Object.keys(wsEnv)"
          :data-test="`repo-env-${i}`"
          @add-secret="(k: string, v: string) => addRepoSecret(repo, k, v)"
          @remove-secret="(k: string) => removeRepoSecret(repo, k)"
        />
        <p v-if="!repo.id" class="env-hint" :data-test="`repo-env-new-${i}`">
          Save the workspace to add secret variables to a new repository.
        </p>
      </div>
    </div>
    <el-button data-test="add-repo" @click="addRepository">Add repository</el-button>
  </el-form>
</template>

<style scoped lang="scss">
.environment-form {
  max-width: 640px;
}
.repo-block {
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  margin-bottom: 8px;
}
.repo-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.repo-env {
  padding-left: 4px;
}
.repo-env-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.env-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 2px 0 8px;
}
</style>

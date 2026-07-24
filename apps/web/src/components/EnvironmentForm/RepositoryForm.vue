<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { WorkspaceRepository, EnvSecretKeys } from '@brigadir/contracts';
import { useUpdateSettings, useUpdateEnvSecrets } from '../../composables/useWorkspaces';
import EnvVarsTable from '../EnvVarsTable/EnvVarsTable.vue';

/**
 * Single-repository editor (feature 031 settings restructure). Edits ONE repo
 * (name, git URL, default branch) plus its non-secret env; secret env is
 * write-only and persists immediately via the env-secrets endpoint (scope:
 * { repository_id }). Repo fields + non-secret env save with the form.
 *
 * Because the settings PATCH replaces the whole repositories array, this form
 * takes the FULL current list and rebuilds it with this repo replaced (by id)
 * or appended (create mode). A brand-new repo has no id yet, so secret env is
 * disabled until the first save assigns one.
 */
const props = defineProps<{
  workspaceId: string;
  /** The full current repository list (rebuilt on save). */
  repositories: WorkspaceRepository[];
  /** The repo being edited; null = create a new one. */
  repo: WorkspaceRepository | null;
  /** Names-only secret view, to seed this repo's masked secret rows. */
  envSecretKeys?: EnvSecretKeys;
  /** Workspace default keys, for the "overrides" badges. */
  workspaceEnvKeys?: string[];
}>();
const emit = defineEmits<{ saved: []; removed: [] }>();

const isEdit = computed(() => props.repo != null);
const form = reactive({
  name: props.repo?.name ?? '',
  git_url: props.repo?.git_url ?? '',
  default_branch: props.repo?.default_branch ?? 'main',
});
const repoEnv = ref<Record<string, string>>({ ...(props.repo?.env ?? {}) });
const repoId = props.repo?.id;
const secretKeys = ref<string[]>(repoId ? (props.envSecretKeys?.repos[repoId] ?? []) : []);

const updateSettings = useUpdateSettings(props.workspaceId);
const envSecrets = useUpdateEnvSecrets(props.workspaceId);
const saving = computed(() => updateSettings.isPending.value);

const canSave = computed(() => !!form.name && !!form.git_url && !!form.default_branch);

function addSecret(key: string, value: string) {
  if (!repoId) return; // new repo: save first to get an id
  void envSecrets
    .mutateAsync({ scope: { repository_id: repoId }, set: { [key]: value } })
    .then((res) => (secretKeys.value = res.env_secret_keys.repos[repoId] ?? []));
}
function removeSecret(key: string) {
  if (!repoId) return;
  void envSecrets
    .mutateAsync({ scope: { repository_id: repoId }, delete: [key] })
    .then((res) => (secretKeys.value = res.env_secret_keys.repos[repoId] ?? []));
}

/** The full repositories array with this repo replaced (by id) or appended. */
function nextRepositories(): WorkspaceRepository[] {
  const env = Object.keys(repoEnv.value).length ? repoEnv.value : undefined;
  const edited: WorkspaceRepository = {
    ...(props.repo ?? {}),
    name: form.name,
    git_url: form.git_url,
    default_branch: form.default_branch,
    env,
  };
  if (!isEdit.value) return [...props.repositories, edited];
  // Match by id when present (post-backfill), else by object identity — never
  // by `undefined === undefined`, which would rewrite every id-less repo.
  return props.repositories.map((r) => (r === props.repo || (!!repoId && r.id === repoId) ? edited : r));
}

async function submit() {
  if (!canSave.value) return;
  await updateSettings.mutateAsync({ repositories: nextRepositories() });
  emit('saved');
}

async function remove() {
  if (!isEdit.value) return;
  await updateSettings.mutateAsync({
    repositories: props.repositories.filter((r) => !(r === props.repo || (!!repoId && r.id === repoId))),
  });
  emit('removed');
}

defineExpose({ submit, saving, canSave, remove, isEdit });
</script>

<template>
  <el-form label-position="top" class="repository-form">
    <div class="fields">
      <el-form-item label="Name">
        <el-input v-model="form.name" placeholder="product" data-test="repo-form-name" />
      </el-form-item>
      <el-form-item label="Git URL">
        <el-input v-model="form.git_url" placeholder="git@github.com:acme/product.git" data-test="repo-form-url" />
      </el-form-item>
      <el-form-item label="Default branch">
        <el-input v-model="form.default_branch" placeholder="main" data-test="repo-form-branch" />
      </el-form-item>
    </div>

    <h4 class="sub">Environment</h4>
    <EnvVarsTable
      v-model="repoEnv"
      :secret-keys="secretKeys"
      :inherited-keys="workspaceEnvKeys ?? []"
      data-test="repo-form-env"
      @add-secret="addSecret"
      @remove-secret="removeSecret"
    />
    <p v-if="!repoId" class="env-hint" data-test="repo-form-new-hint">
      Save the repository first to add secret variables.
    </p>
  </el-form>
</template>

<style scoped lang="scss">
.repository-form {
  max-width: 640px;
}
.fields {
  display: flex;
  flex-direction: column;
}
.sub {
  margin: 8px 0;
  font-size: 14px;
  font-weight: 600;
}
.env-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 6px 0 0;
}
</style>

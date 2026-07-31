<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { WorkspaceRepository, EnvSecretKeys } from '@brigadir/contracts';
import { useUpdateSettings, useUpdateEnvSecrets } from '../../composables/useWorkspaces';
import EnvVarsTable from '../EnvVarsTable/EnvVarsTable.vue';
import BulkEnvEditor from '../BulkEnvEditor/BulkEnvEditor.vue';
import type { BulkEnvResult } from '../BulkEnvEditor/bulk-env';

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
  // Feature 035: optional platform-run bootstrap ("" ⇒ field omitted on save).
  bootstrap_command: props.repo?.bootstrap_command ?? '',
});
const repoEnv = ref<Record<string, string>>({ ...(props.repo?.env ?? {}) });
const repoId = props.repo?.id;
const secretKeys = ref<string[]>(repoId ? (props.envSecretKeys?.repos[repoId] ?? []) : []);
// Plain keys the user flipped to secret in the table — sealed on Save (below).
const promoteKeys = ref<string[]>([]);
const envError = ref('');

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

// --- bulk ".env" editor ---
const showBulk = ref(false);
function onBulkApply({ plainEnv, secretSet, secretDelete }: BulkEnvResult) {
  repoEnv.value = plainEnv; // replace non-secret env (saved with the form)
  const set = Object.keys(secretSet).length ? secretSet : undefined;
  const del = secretDelete.length ? secretDelete : undefined;
  // Secret changes persist immediately (write-only store); a new repo has no id
  // and therefore no existing secrets to mask, so nothing to send.
  if (repoId && (set || del)) {
    void envSecrets
      .mutateAsync({ scope: { repository_id: repoId }, set, delete: del })
      .then((res) => (secretKeys.value = res.env_secret_keys.repos[repoId] ?? []));
  }
}

/** Plaintext env for this repo, EXCLUDING keys promoted to secret on this save. */
function plaintextEnv(): Record<string, string> | undefined {
  const src = { ...repoEnv.value };
  for (const k of promoteKeys.value) delete src[k];
  return Object.keys(src).length ? src : undefined;
}

/** The full repositories array with this repo replaced (by id) or appended. */
function nextRepositories(): WorkspaceRepository[] {
  const env = plaintextEnv();
  const bootstrapCommand = form.bootstrap_command.trim();
  const edited: WorkspaceRepository = {
    ...(props.repo ?? {}),
    name: form.name,
    git_url: form.git_url,
    default_branch: form.default_branch,
    env,
    bootstrap_command: bootstrapCommand || undefined,
  };
  if (!isEdit.value) return [...props.repositories, edited];
  // Match by id when present (post-backfill), else by object identity — never
  // by `undefined === undefined`, which would rewrite every id-less repo.
  return props.repositories.map((r) => (r === props.repo || (!!repoId && r.id === repoId) ? edited : r));
}

async function submit() {
  if (!canSave.value) return;
  envError.value = '';
  // Settings PUT first (drops promoted keys from plaintext), then seal them —
  // the only order the backend's "one home per key" guards accept. repoEnv is
  // never mutated here, so a failed seal is retry-safe.
  await updateSettings.mutateAsync({ repositories: nextRepositories() });
  if (promoteKeys.value.length && repoId) {
    try {
      const set = Object.fromEntries(promoteKeys.value.map((k) => [k, repoEnv.value[k]]));
      const res = await envSecrets.mutateAsync({ scope: { repository_id: repoId }, set });
      secretKeys.value = res.env_secret_keys.repos[repoId] ?? [];
    } catch {
      envError.value = 'Repository saved, but sealing secrets failed — retry.';
      return; // keep the modal open; retry re-runs both calls safely
    }
  }
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
      <el-form-item label="Bootstrap command">
        <el-input
          v-model="form.bootstrap_command"
          placeholder="npm ci"
          maxlength="500"
          data-test="repo-form-bootstrap"
        />
        <div class="hint">
          Runs in the fresh worktree before every agent session (e.g. dependency install).
          Non-secret — put tokens in Environment below.
        </div>
      </el-form-item>
    </div>

    <!-- Env is edit-only: a brand-new repo has no id yet, so secrets can't be
         sealed. Create the repo first, then manage env via its Edit modal. -->
    <template v-if="isEdit">
      <div class="env-head">
        <h4 class="sub">Environment</h4>
        <el-button size="small" data-test="repo-bulk-env" @click="showBulk = true">Add from .env</el-button>
      </div>
      <EnvVarsTable
        v-model="repoEnv"
        v-model:promote-keys="promoteKeys"
        :secret-keys="secretKeys"
        :inherited-keys="workspaceEnvKeys ?? []"
        :secrets-enabled="!!repoId"
        data-test="repo-form-env"
        @add-secret="addSecret"
        @remove-secret="removeSecret"
      />
      <p v-if="envError" class="err" data-test="repo-env-error">{{ envError }}</p>

      <BulkEnvEditor
        v-model="showBulk"
        :plain-env="repoEnv"
        :secret-keys="secretKeys"
        @apply="onBulkApply"
      />
    </template>
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
.env-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 8px 0;
}
.sub {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.err {
  color: var(--el-color-danger);
  font-size: 13px;
  margin: 8px 0 0;
}
.hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.4;
}
</style>

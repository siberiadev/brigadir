<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { WorkspaceRepository, EnvSecretKeys, EnvSecretScope } from '@brigadir/contracts';
import { useUpdateSettings, useTicketCount, useUpdateEnvSecrets } from '../../composables/useWorkspaces';
import EnvVarsTable from '../EnvVarsTable/EnvVarsTable.vue';

/**
 * Configuration form body (feature 008, US2) — branch prefix, advanced scope
 * JQL, and the ordered repository list (first = default). Extracted from the old
 * standalone WorkspaceSettings so the configuration block's Edit modal hosts it
 * inside the shared FormDialog. Exposes `submit()`/`saving` and emits `saved`,
 * mirroring ExecutorForm.
 *
 * Every input SEEDS from the persisted response values (FR-014) — an unset
 * `branch_prefix` seeds EMPTY, never the hard-coded `feat` that the old form used
 * (which could silently overwrite a customized prefix on re-save).
 */
const props = defineProps<{
  workspaceId: string;
  branchPrefix: string | null;
  scopeJql: string | null;
  repositories: WorkspaceRepository[];
  // Feature 031: non-secret workspace env defaults + names-only secret view.
  env?: Record<string, string>;
  envSecretKeys?: EnvSecretKeys;
}>();
const emit = defineEmits<{ saved: [] }>();

const form = reactive({
  branch_prefix: props.branchPrefix ?? '',
  scope_jql: props.scopeJql ?? '',
});
// env is always a defined object in the editing model (empty when unset), so the
// per-repo EnvVarsTable v-model never sees `undefined`.
type EditableRepo = WorkspaceRepository & { env: Record<string, string> };
const repositories = ref<EditableRepo[]>(
  props.repositories.map((r) => ({ ...r, env: { ...(r.env ?? {}) } })),
);

// Feature 031: workspace-level env defaults (non-secret; edited in place, saved
// with the form). Secret env is write-only and persisted IMMEDIATELY through
// the env-secrets endpoint (separate from this form's save).
const wsEnv = ref<Record<string, string>>({ ...(props.env ?? {}) });
const secretKeys = ref<EnvSecretKeys>(
  props.envSecretKeys ?? { workspace: [], repos: {}, agents: {} },
);
const envSecrets = useUpdateEnvSecrets(props.workspaceId);

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
// Open the advanced pane when a scope filter is already set, so the seeded value
// is visible without an extra click.
const showAdvanced = ref(!!props.scopeJql);

const updateSettings = useUpdateSettings(props.workspaceId);
const saving = computed(() => updateSettings.isPending.value);

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
    scope_jql: form.scope_jql || undefined,
    branch_prefix: form.branch_prefix || undefined,
    repositories: repos,
    // Feature 031: workspace-level non-secret env defaults (empty object clears).
    env: wsEnv.value,
  });
  emit('saved');
}

// --- live-Jira scope preview ---
// Counts against the SAVED scope_jql, so it's only meaningful when the field is
// unchanged. A dirty scope_jql disables the button (save first, then preview).
const ticketCount = useTicketCount(props.workspaceId);
const previewResult = ref('');
const scopeDirty = computed(() => (form.scope_jql || '') !== (props.scopeJql ?? ''));

async function previewCount() {
  previewResult.value = '';
  try {
    const res = await ticketCount.mutateAsync({});
    previewResult.value =
      res.active_sprint_ids.length === 0 && res.count === 0
        ? 'No active sprint on this board — nothing in scope.'
        : `${res.count} ticket(s) in scope.`;
  } catch (err) {
    previewResult.value = (err as Error)?.message ?? 'Preview failed.';
  }
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="config-form">
    <el-form-item label="Default branch prefix">
      <el-input v-model="form.branch_prefix" placeholder="feat" data-test="branch-prefix" />
    </el-form-item>

    <el-divider>
      <el-button link data-test="toggle-advanced" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? 'Hide' : 'Show' }} advanced
      </el-button>
    </el-divider>
    <el-form-item v-if="showAdvanced" label="Scope JQL (advanced)">
      <el-input v-model="form.scope_jql" data-test="scope-jql">
        <template #append>
          <el-button
            data-test="scope-preview-button"
            :loading="ticketCount.isPending.value"
            :disabled="scopeDirty"
            @click="previewCount"
          >
            Preview ticket count
          </el-button>
        </template>
      </el-input>
      <div v-if="scopeDirty" class="preview-hint" data-test="scope-preview-dirty">
        Save to preview the new scope.
      </div>
      <div v-else-if="previewResult" class="preview-hint" data-test="scope-preview-result">
        {{ previewResult }}
      </div>
    </el-form-item>

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
    <div
      v-for="(repo, i) in repositories"
      :key="i"
      class="repo-block"
      :data-test="`repo-row-${i}`"
    >
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
.config-form {
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
.preview-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>

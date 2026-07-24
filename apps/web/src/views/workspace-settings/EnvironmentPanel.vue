<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { WorkspaceRepository } from '@brigadir/contracts';
import { useWorkspace } from '../../composables/useWorkspaces';
import WorkspaceEnvForm from '../../components/EnvironmentForm/WorkspaceEnvForm.vue';
import RepositoryForm from '../../components/EnvironmentForm/RepositoryForm.vue';
import EnvVarsReadonly from '../../components/EnvVarsReadonly/EnvVarsReadonly.vue';
import FormDialog from '../../components/FormDialog.vue';

/**
 * Workspace Settings → Environment panel (feature 031). Read-only view of the
 * workspace env defaults + the repository list with per-repo env. The workspace
 * defaults have ONE Edit modal (WorkspaceEnvForm). Repositories are managed one
 * at a time: an "Add repository" button and a per-card Edit button, each opening
 * RepositoryForm for a single repo (its fields + its env). Repos render as a
 * single-open accordion; each body shows a read-only key | value | type list
 * (EnvVarsReadonly). Secret values never leave the server, so they show masked.
 */
const props = defineProps<{ id: string }>();

const workspaceQuery = useWorkspace(props.id);
const workspace = computed(() => workspaceQuery.data.value);

const wsEnvEntries = computed(() => Object.entries(workspace.value?.env ?? {}));
const wsSecretKeys = computed(() => workspace.value?.env_secret_keys.workspace ?? []);
const workspaceEnvKeys = computed(() => Object.keys(workspace.value?.env ?? {}));
const repositories = computed(() => workspace.value?.repositories ?? []);
function repoEnvEntries(repo: { env?: Record<string, string> }) {
  return Object.entries(repo.env ?? {});
}
function repoSecretKeys(repo: { id?: string }): string[] {
  const id = repo.id;
  return id ? (workspace.value?.env_secret_keys.repos[id] ?? []) : [];
}

// --- workspace defaults modal ---
const showWsEdit = ref(false);
const wsFormRef = ref<InstanceType<typeof WorkspaceEnvForm>>();
function onWsSaved() {
  showWsEdit.value = false;
  ElMessage.success('Environment defaults saved — effective on the next run.');
}

// --- per-repository modal (edit one, or add a new one) ---
const showRepoEdit = ref(false);
const editingRepo = ref<WorkspaceRepository | null>(null);
const repoFormRef = ref<InstanceType<typeof RepositoryForm>>();
// Single-open accordion: the name of the currently-expanded repo card ('' = none).
const openRepoName = ref('');
function openRepo(repo: WorkspaceRepository | null) {
  editingRepo.value = repo;
  showRepoEdit.value = true;
}
function onRepoSaved() {
  showRepoEdit.value = false;
  ElMessage.success('Repository saved — effective on the next run.');
}
function onRepoRemoved() {
  showRepoEdit.value = false;
  ElMessage.success('Repository removed.');
}
const repoDialogTitle = computed(() => (editingRepo.value ? 'Edit repository' : 'Add repository'));
</script>

<template>
  <div v-if="workspace" class="panel" data-test="settings-environment-panel">
    <h3 class="panel-title">Environment</h3>

    <!-- Workspace-level defaults: one Edit modal -->
    <div class="block-head">
      <h4 class="sub">Workspace defaults</h4>
      <el-button type="primary" link data-test="edit-environment" @click="showWsEdit = true">Edit</el-button>
    </div>
    <div v-if="wsEnvEntries.length || wsSecretKeys.length" data-test="ws-env-readonly">
      <EnvVarsReadonly :plain="workspace.env ?? {}" :secret-keys="wsSecretKeys" />
    </div>
    <p v-else class="empty" data-test="ws-env-empty">No workspace-level variables.</p>

    <!-- Repositories: add + per-card edit -->
    <div class="block-head repos-head">
      <h4 class="sub">Repositories (first = default)</h4>
      <el-button type="primary" data-test="add-repo" @click="openRepo(null)">Add repository</el-button>
    </div>
    <p v-if="!repositories.length" class="empty" data-test="config-repos-empty">No repositories configured</p>
    <el-collapse v-else v-model="openRepoName" accordion class="repo-collapse">
      <el-collapse-item
        v-for="(repo, i) in repositories"
        :key="repo.id ?? i"
        :name="repo.id ?? String(i)"
        :data-test="`config-repo-${i}`"
      >
        <template #title>
          <span class="repo-head">
            <span class="repo-name">{{ repo.name }}</span>
            <span class="repo-url">{{ repo.git_url }}</span>
            <el-tag v-if="i === 0" size="small" data-test="config-repo-default-tag">Default</el-tag>
            <span class="spacer" />
            <el-button type="primary" link :data-test="`edit-repo-${i}`" @click.stop="openRepo(repo)">Edit</el-button>
          </span>
        </template>
        <EnvVarsReadonly
          v-if="repoEnvEntries(repo).length || repoSecretKeys(repo).length"
          :plain="repo.env ?? {}"
          :secret-keys="repoSecretKeys(repo)"
          :data-test="`repo-env-readonly-${i}`"
        />
        <p v-else class="empty">No variables.</p>
      </el-collapse-item>
    </el-collapse>

    <!-- Edit: workspace defaults -->
    <FormDialog v-model="showWsEdit" title="Edit environment defaults">
      <WorkspaceEnvForm
        v-if="showWsEdit"
        ref="wsFormRef"
        :workspace-id="id"
        :env="workspace.env"
        :env-secret-keys="workspace.env_secret_keys"
        @saved="onWsSaved"
      />
      <template #footer>
        <el-button data-test="environment-cancel" @click="showWsEdit = false">Cancel</el-button>
        <el-button type="primary" data-test="save-environment" :loading="wsFormRef?.saving" @click="wsFormRef?.submit()">
          Save defaults
        </el-button>
      </template>
    </FormDialog>

    <!-- Edit / add: one repository -->
    <FormDialog v-model="showRepoEdit" :title="repoDialogTitle">
      <RepositoryForm
        v-if="showRepoEdit"
        ref="repoFormRef"
        :workspace-id="id"
        :repositories="repositories"
        :repo="editingRepo"
        :env-secret-keys="workspace.env_secret_keys"
        :workspace-env-keys="workspaceEnvKeys"
        @saved="onRepoSaved"
        @removed="onRepoRemoved"
      />
      <template #footer>
        <el-button data-test="repo-cancel" @click="showRepoEdit = false">Cancel</el-button>
        <el-button
          v-if="repoFormRef?.isEdit"
          type="danger"
          plain
          data-test="repo-remove"
          @click="repoFormRef?.remove()"
        >
          Remove
        </el-button>
        <el-button
          type="primary"
          data-test="repo-save"
          :loading="repoFormRef?.saving"
          :disabled="!repoFormRef?.canSave"
          @click="repoFormRef?.submit()"
        >
          Save repository
        </el-button>
      </template>
    </FormDialog>
  </div>
  <el-empty v-else description="Workspace not found" />
</template>

<style scoped lang="scss">
.panel-title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.repos-head {
  margin-top: 20px;
}
.sub {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[data-test='ws-env-readonly'] {
  margin-top: 8px;
}
.empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 4px 0;
}
.repo-collapse {
  margin-top: 10px;
  --el-collapse-header-height: 44px;
}
// The title slot holds the whole repo-head row; let it fill the header width so
// the Edit button sits flush right (before the chevron).
.repo-head {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding-right: 8px;
}
.repo-name {
  font-weight: 600;
}
.repo-url {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspace } from '../../composables/useWorkspaces';
import EnvironmentForm from '../../components/EnvironmentForm/EnvironmentForm.vue';
import FormDialog from '../../components/FormDialog.vue';

/**
 * Workspace Settings → Environment panel (feature 031). Read-only view of the
 * workspace env defaults, the repository list, and per-repo env (values for
 * non-secret vars, "secret" tags for sealed ones — values are never shown). An
 * Edit modal (EnvironmentForm) manages everything; secret rows persist
 * immediately, non-secret rows + repos on Save.
 */
const props = defineProps<{ id: string }>();

const workspaceQuery = useWorkspace(props.id);
const workspace = computed(() => workspaceQuery.data.value);

const wsEnvEntries = computed(() => Object.entries(workspace.value?.env ?? {}));
const wsSecretKeys = computed(() => workspace.value?.env_secret_keys.workspace ?? []);
function repoEnvEntries(repo: { env?: Record<string, string> }) {
  return Object.entries(repo.env ?? {});
}
function repoSecretKeys(repo: { id?: string }): string[] {
  const id = repo.id;
  return id ? (workspace.value?.env_secret_keys.repos[id] ?? []) : [];
}

const showEdit = ref(false);
const formRef = ref<InstanceType<typeof EnvironmentForm>>();
function onSaved() {
  showEdit.value = false;
  ElMessage.success('Environment saved — effective on the next run.');
}
</script>

<template>
  <div v-if="workspace" class="panel" data-test="settings-environment-panel">
    <div class="block-head">
      <h3>Environment</h3>
      <el-button type="primary" link data-test="edit-environment" @click="showEdit = true">Edit</el-button>
    </div>

    <h4 class="sub">Workspace defaults</h4>
    <div v-if="wsEnvEntries.length || wsSecretKeys.length" class="env-list" data-test="ws-env-readonly">
      <div v-for="[k, v] in wsEnvEntries" :key="`p-${k}`" class="env-line">
        <span class="env-key">{{ k }}</span><span class="env-val">{{ v }}</span>
      </div>
      <div v-for="k in wsSecretKeys" :key="`s-${k}`" class="env-line">
        <span class="env-key">{{ k }}</span>
        <span class="env-val masked">••••</span>
        <el-tag size="small" type="warning">secret</el-tag>
      </div>
    </div>
    <p v-else class="empty" data-test="ws-env-empty">No workspace-level variables.</p>

    <h4 class="sub">Repositories (first = default)</h4>
    <p v-if="!workspace.repositories.length" class="empty" data-test="config-repos-empty">
      No repositories configured
    </p>
    <div v-else class="repo-list">
      <div v-for="(repo, i) in workspace.repositories" :key="i" class="repo-card" :data-test="`config-repo-${i}`">
        <div class="repo-head">
          <span class="repo-name">{{ repo.name }}</span>
          <span class="repo-url">{{ repo.git_url }}</span>
          <el-tag v-if="i === 0" size="small" data-test="config-repo-default-tag">Default</el-tag>
        </div>
        <div
          v-if="repoEnvEntries(repo).length || repoSecretKeys(repo).length"
          class="env-list repo-env"
          :data-test="`repo-env-readonly-${i}`"
        >
          <div v-for="[k, v] in repoEnvEntries(repo)" :key="`p-${k}`" class="env-line">
            <span class="env-key">{{ k }}</span><span class="env-val">{{ v }}</span>
          </div>
          <div v-for="k in repoSecretKeys(repo)" :key="`s-${k}`" class="env-line">
            <span class="env-key">{{ k }}</span>
            <span class="env-val masked">••••</span>
            <el-tag size="small" type="warning">secret</el-tag>
          </div>
        </div>
        <p v-else class="empty repo-env">No variables.</p>
      </div>
    </div>

    <FormDialog v-model="showEdit" title="Edit environment">
      <EnvironmentForm
        v-if="showEdit"
        ref="formRef"
        :workspace-id="id"
        :repositories="workspace.repositories"
        :env="workspace.env"
        :env-secret-keys="workspace.env_secret_keys"
        @saved="onSaved"
      />
      <template #footer>
        <el-button data-test="environment-cancel" @click="showEdit = false">Cancel</el-button>
        <el-button type="primary" data-test="save-environment" :loading="formRef?.saving" @click="formRef?.submit()">
          Save environment
        </el-button>
      </template>
    </FormDialog>
  </div>
  <el-empty v-else description="Workspace not found" />
</template>

<style scoped lang="scss">
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.block-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.sub {
  margin: 20px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.env-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.env-line {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.env-key {
  font-family: var(--brigadir-font-mono, monospace);
  min-width: 30%;
}
.env-val {
  color: var(--el-text-color-secondary);
  font-family: var(--brigadir-font-mono, monospace);
}
.masked {
  color: var(--el-text-color-placeholder);
}
.empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 4px 0;
}
.repo-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.repo-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
}
.repo-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.repo-name {
  font-weight: 600;
}
.repo-url {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.repo-env {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
</style>

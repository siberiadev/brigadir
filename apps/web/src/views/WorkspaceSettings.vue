<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { ExecutorResponse, WorkspaceRepository } from '@brigadir/contracts';
import { useWorkspaces, useRotateConnection, useUpdateSettings } from '../composables/useWorkspaces';
import { useExecutors, useDeleteExecutor } from '../composables/useExecutors';
import { ApiError } from '../api/client';
import { defaultExpiry } from '../utils/date';
import CredentialBadge from '../components/CredentialBadge.vue';
import ExecutorForm from '../components/ExecutorForm/ExecutorForm.vue';
import FormDialog from '../components/FormDialog.vue';

const props = defineProps<{ id: string }>();

const workspacesQuery = useWorkspaces();
const workspace = computed(() =>
  (workspacesQuery.data.value ?? []).find((w) => w.id === props.id),
);

// --- token rotation (PUT /jira-connection re-verifies live, server-side) ---
const rotate = useRotateConnection(props.id);
const rotation = reactive({ jira_email: '', jira_api_token: '' });
const rotationExpiry = ref<Date>(defaultExpiry());
const rotationError = ref('');

async function reconnect() {
  rotationError.value = '';
  try {
    await rotate.mutateAsync({
      jira_email: rotation.jira_email,
      jira_api_token: rotation.jira_api_token,
      expires_at: rotationExpiry.value.toISOString(),
    });
    rotation.jira_api_token = '';
    ElMessage.success('Connection updated.');
  } catch (err) {
    // A re-verify failure keeps the OLD credentials (server retains them); we
    // surface the message inline and leave the displayed connection intact.
    if (err instanceof ApiError) {
      rotationError.value = err.issueFor('jira_api_token')?.message ?? err.message;
    } else {
      rotationError.value = (err as Error)?.message ?? 'Reconnect failed.';
    }
  }
}

// --- settings (scope_jql / branch_prefix / repositories) ---
// The workspace response exposes repositories but not scope_jql/branch_prefix,
// so those start from sensible defaults (persisted on save; take effect next pass).
const settings = reactive({ scope_jql: '', branch_prefix: 'feat' });
const repositories = ref<WorkspaceRepository[]>([]);
const showAdvanced = ref(false);

watch(
  workspace,
  (ws) => {
    if (ws) repositories.value = ws.repositories.map((r) => ({ ...r }));
  },
  { immediate: true },
);

const updateSettings = useUpdateSettings(props.id);

function addRepository() {
  repositories.value.push({ name: '', git_url: '', default_branch: 'main' });
}
function removeRepository(index: number) {
  repositories.value.splice(index, 1);
}

async function saveSettings() {
  const repos = repositories.value.filter((r) => r.name && r.git_url && r.default_branch);
  await updateSettings.mutateAsync({
    scope_jql: settings.scope_jql || undefined,
    branch_prefix: settings.branch_prefix || undefined,
    repositories: repos,
  });
  ElMessage.success('Settings saved — effective on the next poller pass.');
}

// --- executors admin (US4) ---
const executorsQuery = useExecutors(props.id);
const deleteExecutor = useDeleteExecutor(props.id);
const showExecutorForm = ref(false);
const editingExecutor = ref<ExecutorResponse | null>(null);
const executorFormRef = ref<InstanceType<typeof ExecutorForm>>();

function openCreateExecutor() {
  editingExecutor.value = null;
  showExecutorForm.value = true;
}
function openEditExecutor(ex: ExecutorResponse) {
  editingExecutor.value = ex;
  showExecutorForm.value = true;
}
function onExecutorSaved() {
  showExecutorForm.value = false;
  ElMessage.success('Executor saved.');
}
async function onDeleteExecutor(ex: ExecutorResponse) {
  try {
    await deleteExecutor.mutateAsync(ex.id);
    ElMessage.success('Executor deleted.');
  } catch (err) {
    // 409 executor_in_use names the referencing agents — surface it verbatim.
    const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Delete failed.';
    ElMessage.error(msg);
  }
}
</script>

<template>
  <div v-if="workspace" class="settings">
    <div class="block">
      <div class="block-head">
        <h3>Jira connection</h3>
        <CredentialBadge :status="workspace.credential_status" />
      </div>
      <p class="hint">
        Site <strong>{{ workspace.jira_site_url }}</strong> · project
        <strong>{{ workspace.project_key }}</strong>
        <template v-if="workspace.expires_at">
          · token expires {{ new Date(workspace.expires_at).toLocaleDateString() }}
        </template>
      </p>

      <el-form label-position="top">
        <el-form-item label="Bot email">
          <el-input v-model="rotation.jira_email" data-test="rotate-email" />
        </el-form-item>
        <el-form-item label="New API token">
          <el-input v-model="rotation.jira_api_token" type="password" data-test="rotate-token" />
        </el-form-item>
        <el-form-item label="Token expiry">
          <el-date-picker v-model="rotationExpiry" type="date" data-test="rotate-expiry" />
        </el-form-item>
      </el-form>

      <div v-if="rotationError" class="field-error" data-test="rotate-error">{{ rotationError }}</div>

      <el-button
        type="primary"
        data-test="reconnect-button"
        :loading="rotate.isPending.value"
        @click="reconnect"
      >
        Reconnect (re-verify)
      </el-button>
    </div>

    <div class="block">
      <h3>Configuration</h3>
      <el-form label-position="top">
        <el-form-item label="Default branch prefix">
          <el-input v-model="settings.branch_prefix" data-test="branch-prefix" />
        </el-form-item>

        <el-divider>
          <el-button link data-test="toggle-advanced" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? 'Hide' : 'Show' }} advanced
          </el-button>
        </el-divider>
        <el-form-item v-if="showAdvanced" label="Scope JQL (advanced)">
          <el-input v-model="settings.scope_jql" data-test="scope-jql" />
        </el-form-item>
      </el-form>

      <h4>Repositories (first = default)</h4>
      <div
        v-for="(repo, i) in repositories"
        :key="i"
        class="repo-row"
        :data-test="`repo-row-${i}`"
      >
        <el-input v-model="repo.name" placeholder="name" :data-test="`repo-name-${i}`" />
        <el-input v-model="repo.git_url" placeholder="git@…" :data-test="`repo-url-${i}`" />
        <el-input v-model="repo.default_branch" placeholder="main" :data-test="`repo-branch-${i}`" />
        <el-button link type="danger" :data-test="`repo-remove-${i}`" @click="removeRepository(i)">
          Remove
        </el-button>
      </div>
      <el-button data-test="add-repo" @click="addRepository">Add repository</el-button>

      <div class="actions">
        <el-button
          type="primary"
          data-test="save-settings"
          :loading="updateSettings.isPending.value"
          @click="saveSettings"
        >
          Save settings
        </el-button>
      </div>
    </div>

    <div class="block">
      <div class="block-head">
        <h3>Executors</h3>
        <el-button type="primary" data-test="new-executor" @click="openCreateExecutor">
          New executor
        </el-button>
      </div>

      <el-table
        v-loading="executorsQuery.isLoading.value"
        :data="executorsQuery.data.value?.items ?? []"
        data-test="executors-table"
      >
        <el-table-column label="Name">
          <template #default="{ row }">
            <span data-test="executor-name-cell">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Type">
          <template #default="{ row }">
            <el-tag size="small" :type="row.type === 'claude_cli' ? 'primary' : 'info'">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="concurrency_limit" label="Concurrency" width="120" />
        <el-table-column label="">
          <template #default="{ row }">
            <el-button link type="primary" :data-test="`executor-edit-${row.id}`" @click="openEditExecutor(row)">
              Edit
            </el-button>
            <el-button link type="danger" :data-test="`executor-delete-${row.id}`" @click="onDeleteExecutor(row)">
              Delete
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <FormDialog v-model="showExecutorForm" :title="editingExecutor ? 'Edit executor' : 'New executor'">
      <ExecutorForm
        v-if="showExecutorForm"
        ref="executorFormRef"
        :key="editingExecutor?.id ?? 'new'"
        :workspace-id="id"
        :executor="editingExecutor"
        :repositories="repositories"
        @saved="onExecutorSaved"
      />
      <template #footer>
        <el-button data-test="executor-cancel" @click="showExecutorForm = false">Cancel</el-button>
        <el-button
          type="primary"
          data-test="executor-save"
          :loading="executorFormRef?.saving"
          @click="executorFormRef?.submit()"
        >
          {{ editingExecutor ? 'Save' : 'Create executor' }}
        </el-button>
      </template>
    </FormDialog>
  </div>
  <el-empty v-else description="Workspace not found" />
</template>

<style scoped lang="scss">
.settings {
  max-width: 640px;
}
.block {
  margin-bottom: 28px;
}
.block h3 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.block-head h3 {
  margin-bottom: 0;
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin: 8px 0;
}
.repo-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.actions {
  margin-top: 16px;
}
</style>

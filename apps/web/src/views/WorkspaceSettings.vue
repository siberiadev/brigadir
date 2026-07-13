<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { ExecutorResponse } from '@brigadir/contracts';
import { useWorkspaces } from '../composables/useWorkspaces';
import { useExecutors, useDeleteExecutor } from '../composables/useExecutors';
import { ApiError } from '../api/client';
import CredentialBadge from '../components/CredentialBadge.vue';
import ExecutorForm from '../components/ExecutorForm/ExecutorForm.vue';
import ConnectionForm from '../components/ConnectionForm/ConnectionForm.vue';
import ConfigForm from '../components/ConfigForm/ConfigForm.vue';
import FormDialog from '../components/FormDialog.vue';

/**
 * Workspace Settings tab (feature 008). Renders the workspace configuration as
 * READ-ONLY `el-descriptions` blocks — Jira connection, configuration, and the
 * existing executors admin (kept verbatim, FR-009). Each editable block carries
 * an Edit button that opens the corresponding form body (ConnectionForm /
 * ConfigForm) inside the shared FormDialog; the modals SEED from the persisted
 * `WorkspaceResponse` (FR-014) and, on save, close + let vue-query refresh the
 * blocks in place (FR-007). Nullable values degrade to placeholders (FR-015).
 */
const props = defineProps<{ id: string }>();

const workspacesQuery = useWorkspaces();
const workspace = computed(() =>
  (workspacesQuery.data.value ?? []).find((w) => w.id === props.id),
);

const tokenExpiry = computed(() => {
  const iso = workspace.value?.expires_at;
  return iso ? new Date(iso).toLocaleDateString() : 'No expiry';
});
const board = computed(() => {
  const ws = workspace.value;
  if (!ws || ws.board_id == null || !ws.board_type) return 'Not configured';
  return `#${ws.board_id} · ${ws.board_type}`;
});

// --- edit modals ---
const showConnection = ref(false);
const showConfig = ref(false);
const connectionFormRef = ref<InstanceType<typeof ConnectionForm>>();
const configFormRef = ref<InstanceType<typeof ConfigForm>>();

function onConnectionSaved() {
  showConnection.value = false;
  ElMessage.success('Connection updated.');
}
function onConfigSaved() {
  showConfig.value = false;
  ElMessage.success('Settings saved — effective on the next poller pass.');
}

// --- executors admin (kept verbatim from feature 006) ---
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
    <!-- Jira connection (read-only) -->
    <div class="block">
      <div class="block-head">
        <h3>Jira connection</h3>
        <el-button
          type="primary"
          link
          data-test="edit-jira-connection"
          @click="showConnection = true"
        >
          Edit
        </el-button>
      </div>
      <el-descriptions :column="1" border data-test="settings-jira-block">
        <el-descriptions-item label="Site">
          <span data-test="jira-site">{{ workspace.jira_site_url }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Project">
          <span data-test="jira-project">{{ workspace.project_key }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Board">
          <span data-test="jira-board">{{ board }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Bot email">
          <span data-test="jira-bot-email">{{ workspace.bot_email ?? '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Token expiry">
          <span data-test="jira-token-expiry">{{ tokenExpiry }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Credential status">
          <span data-test="credential-status">
            <CredentialBadge :status="workspace.credential_status" />
          </span>
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <!-- Configuration (read-only) -->
    <div class="block">
      <div class="block-head">
        <h3>Configuration</h3>
        <el-button type="primary" link data-test="edit-config" @click="showConfig = true">
          Edit
        </el-button>
      </div>
      <el-descriptions :column="1" border data-test="settings-config-block">
        <el-descriptions-item label="Default branch prefix">
          <span data-test="config-branch-prefix">{{ workspace.branch_prefix ?? 'Default (feat)' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Scope filter (advanced)">
          <span data-test="config-scope-jql">{{ workspace.scope_jql ?? 'None' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="Repositories">
          <span v-if="!workspace.repositories.length" data-test="config-repos-empty">
            No repositories configured
          </span>
          <div v-else class="repo-list">
            <div
              v-for="(repo, i) in workspace.repositories"
              :key="i"
              class="repo-line"
              :data-test="`config-repo-${i}`"
            >
              <span class="repo-name">{{ repo.name }}</span>
              <span class="repo-url">{{ repo.git_url }}</span>
              <el-tag v-if="i === 0" size="small" data-test="config-repo-default-tag">Default</el-tag>
            </div>
          </div>
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <!-- Executors admin (unchanged, FR-009) -->
    <div class="block" data-test="settings-executors-block">
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

    <!-- Edit: Jira connection -->
    <FormDialog v-model="showConnection" title="Edit Jira connection">
      <ConnectionForm
        v-if="showConnection"
        ref="connectionFormRef"
        :workspace-id="id"
        :bot-email="workspace.bot_email"
        @saved="onConnectionSaved"
      />
      <template #footer>
        <el-button data-test="connection-cancel" @click="showConnection = false">Cancel</el-button>
        <el-button
          type="primary"
          data-test="reconnect-button"
          :loading="connectionFormRef?.saving"
          @click="connectionFormRef?.submit()"
        >
          Reconnect (re-verify)
        </el-button>
      </template>
    </FormDialog>

    <!-- Edit: configuration -->
    <FormDialog v-model="showConfig" title="Edit configuration">
      <ConfigForm
        v-if="showConfig"
        ref="configFormRef"
        :workspace-id="id"
        :branch-prefix="workspace.branch_prefix"
        :scope-jql="workspace.scope_jql"
        :repositories="workspace.repositories"
        @saved="onConfigSaved"
      />
      <template #footer>
        <el-button data-test="config-cancel" @click="showConfig = false">Cancel</el-button>
        <el-button
          type="primary"
          data-test="save-settings"
          :loading="configFormRef?.saving"
          @click="configFormRef?.submit()"
        >
          Save settings
        </el-button>
      </template>
    </FormDialog>

    <!-- Executor create/edit -->
    <FormDialog v-model="showExecutorForm" :title="editingExecutor ? 'Edit executor' : 'New executor'">
      <ExecutorForm
        v-if="showExecutorForm"
        ref="executorFormRef"
        :key="editingExecutor?.id ?? 'new'"
        :workspace-id="id"
        :executor="editingExecutor"
        :repositories="workspace.repositories"
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
  margin-bottom: 12px;
}
.block-head h3 {
  margin-bottom: 0;
}
.repo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.repo-line {
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
</style>

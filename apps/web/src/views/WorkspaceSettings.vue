<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { WorkspaceRepository } from '@brigadir/contracts';
import { useWorkspaces, useRotateConnection, useUpdateSettings } from '../composables/useWorkspaces';
import { ApiError } from '../api/client';
import { defaultExpiry } from '../utils/date';
import CredentialBadge from '../components/CredentialBadge.vue';

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
</script>

<template>
  <section v-if="workspace" class="settings">
    <h2>Settings — {{ workspace.name }}</h2>

    <el-card class="block">
      <template #header>
        <div class="card-head">
          <span>Jira connection</span>
          <CredentialBadge :status="workspace.credential_status" />
        </div>
      </template>
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
    </el-card>

    <el-card class="block">
      <template #header>Configuration</template>
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
    </el-card>
  </section>
  <el-empty v-else description="Workspace not found" />
</template>

<style scoped>
.settings {
  max-width: 640px;
}
.block {
  margin-bottom: 20px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
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

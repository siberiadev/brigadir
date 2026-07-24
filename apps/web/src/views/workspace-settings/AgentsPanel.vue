<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspace, useUpdateSettings } from '../../composables/useWorkspaces';
import FormDialog from '../../components/FormDialog.vue';

/**
 * Workspace Settings → Agents panel (feature 031 restructure). The feature-030
 * agent role-template SOURCE override (git repo of role instruction templates):
 * effective level, override repo, and the write-only access token. Moved
 * verbatim out of the old single-page WorkspaceSettings.
 */
const props = defineProps<{ id: string }>();

const workspaceQuery = useWorkspace(props.id);
const workspace = computed(() => workspaceQuery.data.value);
const updateSettings = useUpdateSettings(props.id);

const showEdit = ref(false);
const aiGitUrl = ref('');
const aiGitRef = ref('');
const aiSubdir = ref('');
const aiToken = ref('');

const effectiveSourceLabel = computed(() => {
  switch (workspace.value?.effective_instructions_level) {
    case 'workspace':
      return 'This workspace’s own repository';
    case 'global':
      return 'The global repository';
    default:
      return 'Built-in defaults';
  }
});

function openEdit() {
  const src = workspace.value?.agent_instructions ?? null;
  aiGitUrl.value = src?.git_url ?? '';
  aiGitRef.value = src?.git_ref ?? '';
  aiSubdir.value = src?.subdir ?? '';
  aiToken.value = '';
  showEdit.value = true;
}

function save() {
  const url = aiGitUrl.value.trim();
  updateSettings.mutate(
    {
      agent_instructions: url
        ? {
            git_url: url,
            ...(aiGitRef.value.trim() ? { git_ref: aiGitRef.value.trim() } : {}),
            ...(aiSubdir.value.trim() ? { subdir: aiSubdir.value.trim() } : {}),
          }
        : null,
      ...(aiToken.value ? { agent_instructions_token: aiToken.value } : {}),
    },
    {
      onSuccess: () => {
        showEdit.value = false;
        ElMessage.success('Template source saved — effective on the next team generation.');
      },
      onError: () => ElMessage.error('Could not save the template source.'),
    },
  );
}

function useGlobalDefault() {
  updateSettings.mutate(
    { agent_instructions: null },
    {
      onSuccess: () => {
        showEdit.value = false;
        ElMessage.success('Override cleared — using the global / built-in source.');
      },
      onError: () => ElMessage.error('Could not clear the override.'),
    },
  );
}

function clearToken() {
  updateSettings.mutate(
    { agent_instructions_token: '' },
    {
      onSuccess: () => ElMessage.success('Token cleared.'),
      onError: () => ElMessage.error('Could not clear the token.'),
    },
  );
}
</script>

<template>
  <div v-if="workspace" class="panel" data-test="settings-agents-panel">
    <div class="block-head">
      <h3>Agent instructions source</h3>
      <el-button type="primary" link data-test="edit-agent-instructions" @click="openEdit">Edit</el-button>
    </div>
    <el-descriptions :column="1" border data-test="agent-instructions-block">
      <el-descriptions-item label="Effective source">
        <span data-test="ai-effective">{{ effectiveSourceLabel }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="Override repository">
        <span data-test="ai-override">
          {{ workspace.agent_instructions?.git_url ?? 'None (using global / built-in)' }}
        </span>
      </el-descriptions-item>
      <el-descriptions-item label="Access token">
        <span data-test="ai-token-state">
          {{ workspace.has_agent_instructions_token ? 'Token stored' : 'No token' }}
        </span>
      </el-descriptions-item>
    </el-descriptions>

    <FormDialog v-model="showEdit" title="Edit agent instructions source">
      <el-form v-if="showEdit" label-position="top" class="ai-form" @submit.prevent>
        <el-form-item label="Repository URL">
          <el-input
            v-model="aiGitUrl"
            placeholder="git@github.com:acme/agents.git  (empty = use global / built-in)"
            data-test="ai-git-url"
          />
        </el-form-item>
        <div class="ai-row">
          <el-form-item label="Branch / tag / ref (optional)" class="ai-col">
            <el-input v-model="aiGitRef" placeholder="main" data-test="ai-git-ref" />
          </el-form-item>
          <el-form-item label="Subfolder (optional)" class="ai-col">
            <el-input v-model="aiSubdir" placeholder="roles" data-test="ai-subdir" />
          </el-form-item>
        </div>
        <el-form-item label="Access token (private repos only)">
          <el-input
            v-model="aiToken"
            type="password"
            show-password
            :placeholder="
              workspace.has_agent_instructions_token ? '•••••••• stored — type to replace' : 'none stored'
            "
            data-test="ai-token"
          />
          <el-button
            v-if="workspace.has_agent_instructions_token"
            link
            type="danger"
            size="small"
            data-test="ai-clear-token"
            @click="clearToken"
          >
            Clear token
          </el-button>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="ai-cancel" @click="showEdit = false">Cancel</el-button>
        <el-button data-test="ai-use-global" @click="useGlobalDefault">Use global default</el-button>
        <el-button type="primary" :loading="updateSettings.isPending.value" data-test="ai-save" @click="save">
          Save
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
.ai-form {
  margin-top: 4px;
}
.ai-row {
  display: flex;
  gap: 16px;
}
.ai-col {
  flex: 1;
}
</style>

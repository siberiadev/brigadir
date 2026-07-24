<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspace, useSetTicketScoping, useUpdateSettings } from '../composables/useWorkspaces';
import CredentialBadge from '../components/CredentialBadge.vue';
import ConnectionForm from '../components/ConnectionForm/ConnectionForm.vue';
import ConfigForm from '../components/ConfigForm/ConfigForm.vue';
import FormDialog from '../components/FormDialog.vue';

/**
 * Workspace Settings tab (feature 008). Renders the workspace configuration as
 * READ-ONLY `el-descriptions` blocks — Jira connection + Configuration. Each
 * block carries an Edit button that opens the corresponding form body
 * (ConnectionForm / ConfigForm) inside the shared FormDialog; the modals SEED
 * from the persisted `WorkspaceResponse` (FR-014) and, on save, close + let
 * vue-query refresh the blocks in place (FR-007). Nullable values degrade to
 * placeholders (FR-015). The executors admin moved to the PLATFORM Settings
 * page (/settings/executors, 2026-07-13) — executors are global capacity, not
 * workspace config.
 */
const props = defineProps<{ id: string }>();

// Detail-запрос, не поиск по пагинированному списку (UI-конвенция 2026-07-15).
const workspaceQuery = useWorkspace(props.id);
const workspace = computed(() => workspaceQuery.data.value);

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

// Feature 020 (D2b): per-workspace opt-in for ticket repository scoping.
// Inline switch (no modal) — the flag is standalone, like the list's
// enable/pause toggle.
const setTicketScoping = useSetTicketScoping();
function onTicketScopingChange(value: string | number | boolean) {
  setTicketScoping.mutate(
    { workspaceId: props.id, ticketScoping: value === true },
    {
      onSuccess: () =>
        ElMessage.success(
          value === true
            ? 'Ticket scoping enabled — new runs narrow to the ticket\'s Components.'
            : 'Ticket scoping disabled.',
        ),
      onError: () => ElMessage.error('Failed to update ticket scoping.'),
    },
  );
}

// --- feature 030: per-workspace role-template source override ---
const updateSettings = useUpdateSettings(props.id);
const showAiEdit = ref(false);
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

function openAiEdit() {
  const src = workspace.value?.agent_instructions ?? null;
  aiGitUrl.value = src?.git_url ?? '';
  aiGitRef.value = src?.git_ref ?? '';
  aiSubdir.value = src?.subdir ?? '';
  aiToken.value = '';
  showAiEdit.value = true;
}

function saveAi() {
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
        showAiEdit.value = false;
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
        showAiEdit.value = false;
        ElMessage.success('Override cleared — using the global / built-in source.');
      },
      onError: () => ElMessage.error('Could not clear the override.'),
    },
  );
}

function clearAiToken() {
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
        <el-descriptions-item label="Ticket scoping">
          <div class="ticket-scoping">
            <el-switch
              :model-value="workspace.ticket_scoping"
              :loading="setTicketScoping.isPending.value"
              data-test="config-ticket-scoping"
              @change="onTicketScopingChange"
            />
            <span class="ticket-scoping-hint">
              Narrow each run's repositories to the ticket's Jira Components; unresolvable tickets go
              to the human queue.
            </span>
          </div>
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

    <!-- Feature 030: agent role-template source override -->
    <div class="block">
      <div class="block-head">
        <h3>Agent instructions source</h3>
        <el-button
          type="primary"
          link
          data-test="edit-agent-instructions"
          @click="openAiEdit"
        >
          Edit
        </el-button>
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
        :env="workspace.env"
        :env-secret-keys="workspace.env_secret_keys"
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

    <!-- Edit: agent instructions source (feature 030) -->
    <FormDialog v-model="showAiEdit" title="Edit agent instructions source">
      <el-form v-if="showAiEdit" label-position="top" class="ai-form" @submit.prevent>
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
              workspace.has_agent_instructions_token
                ? '•••••••• stored — type to replace'
                : 'none stored'
            "
            data-test="ai-token"
          />
          <el-button
            v-if="workspace.has_agent_instructions_token"
            link
            type="danger"
            size="small"
            data-test="ai-clear-token"
            @click="clearAiToken"
          >
            Clear token
          </el-button>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="ai-cancel" @click="showAiEdit = false">Cancel</el-button>
        <el-button data-test="ai-use-global" @click="useGlobalDefault">Use global default</el-button>
        <el-button
          type="primary"
          :loading="updateSettings.isPending.value"
          data-test="ai-save"
          @click="saveAi"
        >
          Save
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
.ticket-scoping {
  display: flex;
  gap: 10px;
  align-items: center;
}
.ticket-scoping-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
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
.ai-actions {
  display: flex;
  gap: 8px;
}
</style>

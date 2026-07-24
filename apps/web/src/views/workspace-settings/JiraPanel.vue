<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspace } from '../../composables/useWorkspaces';
import CredentialBadge from '../../components/CredentialBadge.vue';
import ConnectionForm from '../../components/ConnectionForm/ConnectionForm.vue';
import FormDialog from '../../components/FormDialog.vue';

/**
 * Workspace Settings → Jira connection panel (feature 031 restructure). The
 * read-only Jira connection block + the re-verify/rotate modal (ConnectionForm),
 * moved verbatim out of the old single-page WorkspaceSettings.
 */
const props = defineProps<{ id: string }>();

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

const showEdit = ref(false);
const formRef = ref<InstanceType<typeof ConnectionForm>>();
function onSaved() {
  showEdit.value = false;
  ElMessage.success('Connection updated.');
}
</script>

<template>
  <div v-if="workspace" class="panel" data-test="settings-jira-panel">
    <div class="block-head">
      <h3>Jira connection</h3>
      <el-button type="primary" link data-test="edit-jira-connection" @click="showEdit = true">Edit</el-button>
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
        <span data-test="credential-status"><CredentialBadge :status="workspace.credential_status" /></span>
      </el-descriptions-item>
    </el-descriptions>

    <FormDialog v-model="showEdit" title="Edit Jira connection">
      <ConnectionForm
        v-if="showEdit"
        ref="formRef"
        :workspace-id="id"
        :bot-email="workspace.bot_email"
        @saved="onSaved"
      />
      <template #footer>
        <el-button data-test="connection-cancel" @click="showEdit = false">Cancel</el-button>
        <el-button type="primary" data-test="reconnect-button" :loading="formRef?.saving" @click="formRef?.submit()">
          Reconnect (re-verify)
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
</style>

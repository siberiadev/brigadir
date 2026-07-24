<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspace, useSetTicketScoping } from '../../composables/useWorkspaces';
import GeneralForm from '../../components/GeneralForm/GeneralForm.vue';
import FormDialog from '../../components/FormDialog.vue';

/**
 * Workspace Settings → General panel (feature 031 restructure). The old
 * Configuration block minus repositories: default branch prefix, advanced scope
 * JQL, and the ticket-scoping switch. Read-only descriptions + an Edit modal
 * (GeneralForm); the scoping switch is an inline standalone toggle.
 */
const props = defineProps<{ id: string }>();

const workspaceQuery = useWorkspace(props.id);
const workspace = computed(() => workspaceQuery.data.value);

const showEdit = ref(false);
const formRef = ref<InstanceType<typeof GeneralForm>>();
function onSaved() {
  showEdit.value = false;
  ElMessage.success('Settings saved — effective on the next poller pass.');
}

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
</script>

<template>
  <div v-if="workspace" class="panel" data-test="settings-general-panel">
    <div class="block-head">
      <h3>General</h3>
      <el-button type="primary" link data-test="edit-config" @click="showEdit = true">Edit</el-button>
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
    </el-descriptions>

    <FormDialog v-model="showEdit" title="Edit general settings">
      <GeneralForm
        v-if="showEdit"
        ref="formRef"
        :workspace-id="id"
        :branch-prefix="workspace.branch_prefix"
        :scope-jql="workspace.scope_jql"
        @saved="onSaved"
      />
      <template #footer>
        <el-button data-test="config-cancel" @click="showEdit = false">Cancel</el-button>
        <el-button type="primary" data-test="save-settings" :loading="formRef?.saving" @click="formRef?.submit()">
          Save settings
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
.ticket-scoping {
  display: flex;
  gap: 10px;
  align-items: center;
}
.ticket-scoping-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  useWorkspace,
  useSetTicketScoping,
  useSetDependencyReleaseStatus,
} from '../../composables/useWorkspaces';
import { useStatuses } from '../../composables/useStatuses';
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

/**
 * Feature 032: the blocker status at which dependents may start. Free text is
 * allowed on purpose (`allow-create`) — a blocker may live in another project
 * whose statuses this board never reports — so an unrecognized value is a
 * non-blocking warning, never a validation failure: the gate simply degrades to
 * the done-category rule.
 */
const statusesQuery = useStatuses(props.id);
const observedStatusNames = computed(
  () => statusesQuery.data.value?.statuses.map((s) => s.name) ?? [],
);
const releaseStatus = computed(() => workspace.value?.dependency_release_status ?? null);
const releaseStatusUnobserved = computed(
  () =>
    !!releaseStatus.value &&
    observedStatusNames.value.length > 0 &&
    !observedStatusNames.value.some(
      (n) => n.trim().toLowerCase() === releaseStatus.value!.trim().toLowerCase(),
    ),
);

const setReleaseStatus = useSetDependencyReleaseStatus();
function onReleaseStatusChange(value: string | null) {
  const next = value && value.trim().length > 0 ? value.trim() : null;
  setReleaseStatus.mutate(
    { workspaceId: props.id, status: next },
    {
      onSuccess: () =>
        ElMessage.success(
          next
            ? `Dependents will start once their blocker reaches "${next}".`
            : 'Dependency release status cleared — dependents wait for Done.',
        ),
      onError: () => ElMessage.error('Failed to update the dependency release status.'),
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
      <el-descriptions-item label="Dependency release status">
        <div class="release-status">
          <el-select
            :model-value="releaseStatus"
            class="release-status-select"
            placeholder="Done only (default)"
            filterable
            allow-create
            clearable
            default-first-option
            :loading="setReleaseStatus.isPending.value"
            data-test="config-dependency-release-status"
            @change="onReleaseStatusChange"
          >
            <el-option v-for="name in observedStatusNames" :key="name" :label="name" :value="name" />
          </el-select>
          <span class="ticket-scoping-hint">
            A ticket blocked by another may start once its blocker reaches this status, instead of
            waiting for Done. Leave empty to keep waiting for Done.
          </span>
          <el-alert
            v-if="releaseStatusUnobserved"
            type="warning"
            :closable="false"
            show-icon
            data-test="release-status-unobserved"
            title="Status not observed on this board — the done-category rule still applies."
          />
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
.release-status {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.release-status-select {
  width: 260px;
}
</style>

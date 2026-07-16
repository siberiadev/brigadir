<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { WorkspaceResponse } from '@brigadir/contracts';
import { useWorkspaces, useSetWorkspaceEnabled } from '../composables/useWorkspaces';
import { usePagination } from '../composables/usePagination';
import CredentialBadge from '../components/CredentialBadge.vue';
import FormDialog from '../components/FormDialog.vue';
import ListPagination from '../components/ListPagination.vue';
import WorkspaceForm from '../components/WorkspaceForm/WorkspaceForm.vue';

const { page, pageSize, params, bindTotal } = usePagination();
const { data: workspaces, isLoading, isError, error } = useWorkspaces(params);
const total = computed(() => workspaces.value?.total ?? 0);
bindTotal(total);
const router = useRouter();

// --- create workspace (flat form in a modal) ---
const showCreate = ref(false);
const workspaceFormRef = ref<InstanceType<typeof WorkspaceForm>>();
function onCreated(id: string) {
  showCreate.value = false;
  // feature 011 (D14): a new workspace starts PAUSED — the create flow lands
  // on Agents where "Generate agents" (or manual creation) builds the team;
  // the Start switch in the list opens the gate when the human is ready.
  ElMessage.info('Workspace created paused — assemble the team, then press Start.');
  router.push(`/workspaces/${id}/agents`);
}

// --- open a workspace by clicking its row body (not an action control) ---
// Lands on Runs — the default tab (реш. 2026-07-15). The create flow above
// deliberately still lands on Agents: a fresh workspace has no runs yet.
function openWorkspace(row: { id: string }) {
  router.push({ name: 'runs', params: { id: row.id } });
}

// --- edit workspace (settings is now the nested tab, reached from the row action) ---
function openSettings(row: { id: string }) {
  router.push({ name: 'settings', params: { id: row.id } });
}

// --- enable/pause a workspace inline (US5) ---
const setEnabled = useSetWorkspaceEnabled();
const pendingId = ref('');
async function togglePause(row: WorkspaceResponse) {
  const enabled = !row.enabled;
  pendingId.value = row.id;
  try {
    await setEnabled.mutateAsync({ workspaceId: row.id, enabled });
    ElMessage.success(enabled ? 'Workspace started.' : 'Workspace paused.');
  } catch (err) {
    ElMessage.error((err as Error)?.message ?? 'Could not update the pause state.');
  } finally {
    pendingId.value = '';
  }
}
</script>

<template>
  <section>
    <div class="header-row">
      <h2>Workspaces</h2>
      <el-button type="primary" data-test="new-workspace" @click="showCreate = true">
        New workspace
      </el-button>
    </div>

    <el-alert v-if="isError" type="error" :closable="false" data-test="workspaces-error">
      {{ (error as Error)?.message ?? 'Failed to load workspaces.' }}
    </el-alert>

    <el-table
      v-else
      v-loading="isLoading"
      :data="workspaces?.items ?? []"
      data-test="workspaces-table"
      class="workspaces-table"
      @row-click="openWorkspace"
    >
      <el-table-column prop="name" label="Name" />
      <el-table-column prop="project_key" label="Project" />
      <el-table-column prop="board_type" label="Board" />
      <el-table-column label="Status">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" data-test="workspace-status">
            {{ row.enabled ? 'Running' : 'Paused' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Credentials">
        <template #default="{ row }">
          <CredentialBadge :status="row.credential_status" />
        </template>
      </el-table-column>
      <el-table-column label="">
        <template #default="{ row }">
          <!-- @click.stop: the row-body click opens the workspace (FR-003); a
               row action must perform only its own action, never navigate (FR-004). -->
          <el-button
            link
            type="primary"
            :data-test="`open-settings-${row.id}`"
            @click.stop="openSettings(row)"
          >
            Settings
          </el-button>
          <el-button
            link
            :type="row.enabled ? 'warning' : 'success'"
            :loading="pendingId === row.id"
            :data-test="`toggle-pause-${row.id}`"
            @click.stop="togglePause(row)"
          >
            {{ row.enabled ? 'Pause' : 'Start' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <ListPagination :total="total" v-model:page="page" v-model:page-size="pageSize" />

    <!-- Create workspace -->
    <FormDialog v-model="showCreate" title="New workspace">
      <WorkspaceForm v-if="showCreate" ref="workspaceFormRef" @created="onCreated" />
      <template #footer>
        <el-button data-test="cancel-button" @click="showCreate = false">Cancel</el-button>
        <el-button
          type="primary"
          data-test="create-button"
          :loading="workspaceFormRef?.saving"
          :disabled="!workspaceFormRef?.canSubmit"
          @click="workspaceFormRef?.submit()"
        >
          Create workspace
        </el-button>
      </template>
    </FormDialog>
  </section>
</template>

<style scoped lang="scss">
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.workspaces-table {
  cursor: pointer;
}
</style>

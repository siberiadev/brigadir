<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { WorkspaceResponse } from '@brigadir/contracts';
import { useWorkspaces, useSetWorkspaceEnabled } from '../composables/useWorkspaces';
import CredentialBadge from '../components/CredentialBadge.vue';
import FormDialog from '../components/FormDialog.vue';
import WorkspaceForm from '../components/WorkspaceForm/WorkspaceForm.vue';
import WorkspaceSettings from './WorkspaceSettings.vue';

const { data: workspaces, isLoading, isError, error } = useWorkspaces();
const router = useRouter();

// --- create workspace (flat form in a modal) ---
const showCreate = ref(false);
const workspaceFormRef = ref<InstanceType<typeof WorkspaceForm>>();
function onCreated(id: string) {
  showCreate.value = false;
  router.push(`/workspaces/${id}/agents`);
}

// --- edit workspace (settings in a modal; each block keeps its own actions) ---
const showSettings = ref(false);
const settingsId = ref('');
const settingsName = ref('');
function openSettings(row: { id: string; name: string }) {
  settingsId.value = row.id;
  settingsName.value = row.name;
  showSettings.value = true;
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

    <el-table v-else v-loading="isLoading" :data="workspaces ?? []" data-test="workspaces-table">
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
          <RouterLink :to="`/workspaces/${row.id}/agents`">
            <el-button link type="primary">Agents</el-button>
          </RouterLink>
          <RouterLink :to="`/workspaces/${row.id}/runs`">
            <el-button link type="primary">Runs</el-button>
          </RouterLink>
          <el-button link type="primary" @click="openSettings(row)">Settings</el-button>
          <el-button
            link
            :type="row.enabled ? 'warning' : 'success'"
            :loading="pendingId === row.id"
            :data-test="`toggle-pause-${row.id}`"
            @click="togglePause(row)"
          >
            {{ row.enabled ? 'Pause' : 'Start' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

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

    <!-- Edit workspace (settings) — no shared footer; blocks carry their own buttons -->
    <FormDialog v-model="showSettings" :title="`Settings — ${settingsName}`">
      <WorkspaceSettings v-if="showSettings" :key="settingsId" :id="settingsId" />
    </FormDialog>
  </section>
</template>

<style scoped lang="scss">
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>

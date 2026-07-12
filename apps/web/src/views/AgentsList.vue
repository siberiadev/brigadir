<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentResponse, ErrorIssue } from '@brigadir/contracts';
import { useAgents, useDeleteAgent } from '../composables/useAgents';
import { useWorkspaces } from '../composables/useWorkspaces';
import AgentForm from '../components/AgentForm/AgentForm.vue';

const props = defineProps<{ id: string }>();

const agentsQuery = useAgents(props.id);
const workspacesQuery = useWorkspaces();
const workspace = computed(() =>
  (workspacesQuery.data.value ?? []).find((w) => w.id === props.id),
);
const repositories = computed(() => workspace.value?.repositories ?? []);

const deleteAgent = useDeleteAgent(props.id);

const showForm = ref(false);
const editing = ref<AgentResponse | null>(null);

function openCreate() {
  editing.value = null;
  showForm.value = true;
}

function openEdit(agent: AgentResponse) {
  editing.value = agent;
  showForm.value = true;
}

function onSaved(warnings: ErrorIssue[]) {
  showForm.value = false;
  if (warnings.length) {
    ElMessage.warning(warnings.map((w) => w.message).join(' '));
  } else {
    ElMessage.success('Agent saved.');
  }
}

async function onDelete(agent: AgentResponse) {
  const res = await deleteAgent.mutateAsync(agent.id);
  ElMessage.success(res.soft_deleted ? 'Agent disabled (had runs).' : 'Agent deleted.');
}
</script>

<template>
  <section>
    <div class="header-row">
      <h2>Agents — {{ workspace?.name ?? id }}</h2>
      <el-button v-if="!showForm" type="primary" data-test="new-agent" @click="openCreate">
        New agent
      </el-button>
    </div>

    <div v-if="showForm">
      <h3>{{ editing ? 'Edit agent' : 'New agent' }}</h3>
      <AgentForm
        :key="editing?.id ?? 'new'"
        :workspace-id="id"
        :agent="editing"
        :repositories="repositories"
        @saved="onSaved"
        @close="showForm = false"
      />
    </div>

    <el-table
      v-else
      v-loading="agentsQuery.isLoading.value"
      :data="agentsQuery.data.value ?? []"
      data-test="agents-table"
    >
      <el-table-column prop="name" label="Name" />
      <el-table-column prop="trigger_status" label="Trigger" />
      <el-table-column prop="status_success" label="Success" />
      <el-table-column label="Enabled">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? 'on' : 'off' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">Edit</el-button>
          <el-button link type="danger" @click="onDelete(row)">Delete</el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>

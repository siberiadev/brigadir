<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentResponse, ErrorIssue } from '@brigadir/contracts';
import { useAgents, useDeleteAgent } from '../composables/useAgents';
import { useWorkspace } from '../composables/useWorkspaces';
import { usePagination } from '../composables/usePagination';
import AgentForm from '../components/AgentForm/AgentForm.vue';
import FormDialog from '../components/FormDialog.vue';
import ListPagination from '../components/ListPagination.vue';

const props = defineProps<{ id: string }>();

const { page, pageSize, params, bindTotal } = usePagination();
const agentsQuery = useAgents(props.id, params);
const total = computed(() => agentsQuery.data.value?.total ?? 0);
bindTotal(total);

// Лукап по id — через detail-эндпоинт, не через пагинированный список.
const workspaceQuery = useWorkspace(props.id);
const repositories = computed(() => workspaceQuery.data.value?.repositories ?? []);

const deleteAgent = useDeleteAgent(props.id);

const showForm = ref(false);
const editing = ref<AgentResponse | null>(null);
const agentFormRef = ref<InstanceType<typeof AgentForm>>();

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
      <h2>Agents</h2>
      <el-button type="primary" data-test="new-agent" @click="openCreate">
        New agent
      </el-button>
    </div>

    <FormDialog v-model="showForm" :title="editing ? 'Edit agent' : 'New agent'">
      <AgentForm
        v-if="showForm"
        ref="agentFormRef"
        :key="editing?.id ?? 'new'"
        :workspace-id="id"
        :agent="editing"
        :repositories="repositories"
        @saved="onSaved"
      />
      <template #footer>
        <el-button data-test="cancel-button" @click="showForm = false">Cancel</el-button>
        <el-button
          type="primary"
          data-test="save-button"
          :loading="agentFormRef?.saving"
          @click="agentFormRef?.submit()"
        >
          {{ editing ? 'Save' : 'Create agent' }}
        </el-button>
      </template>
    </FormDialog>

    <el-table
      v-loading="agentsQuery.isLoading.value"
      :data="agentsQuery.data.value?.items ?? []"
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

    <ListPagination :total="total" v-model:page="page" v-model:page-size="pageSize" />
  </section>
</template>

<style scoped lang="scss">
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>

<script setup lang="ts">
import { computed, markRaw, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { List as ListIcon, Workflow } from 'lucide-vue-next';
import type { AgentResponse, ErrorIssue } from '@brigadir/contracts';
import { MAX_PAGE_SIZE } from '@brigadir/contracts/pagination';
import { ApiError } from '../api/client';
import { useAgents, useDeleteAgent } from '../composables/useAgents';
import { useExecutors } from '../composables/useExecutors';
import { useGenerateAgents, useWorkspace } from '../composables/useWorkspaces';
import { useRuns } from '../composables/useRuns';
import { useStatuses } from '../composables/useStatuses';
import { usePagination } from '../composables/usePagination';
import AgentForm from '../components/AgentForm/AgentForm.vue';
import AgentsDiagram from '../components/AgentsDiagram/AgentsDiagram.vue';
import FormDialog from '../components/FormDialog.vue';
import ListPagination from '../components/ListPagination.vue';

const props = defineProps<{ id: string }>();

const { page, pageSize, params, bindTotal } = usePagination();
const agentsQuery = useAgents(props.id, params);
const total = computed(() => agentsQuery.data.value?.total ?? 0);
bindTotal(total);

// --- feature 018: List/Diagram view mode. Local ref only — the choice is
// never persisted; every visit starts in List (FR-002). Both modes read
// queries mounted HERE, so toggling fetches nothing (FR-003).
const mode = ref<'list' | 'diagram'>('list');
const modeOptions = [
  { label: 'List', value: 'list', icon: markRaw(ListIcon) },
  { label: 'Diagram', value: 'diagram', icon: markRaw(Workflow) },
];

// Diagram data: the whole-list page (byte-identical params to AgentForm's
// roster query → same TanStack cache entry, research R2) + the cached board
// statuses (no refresh — the form still force-refreshes on open).
const allAgentsQuery = useAgents(props.id, { page: 1, page_size: MAX_PAGE_SIZE });
const statusesQuery = useStatuses(props.id);
const diagramAgents = computed(() => allAgentsQuery.data.value?.items ?? []);
const diagramStatuses = computed(() => statusesQuery.data.value?.statuses ?? []);
const diagramLoading = computed(
  () => allAgentsQuery.isLoading.value || statusesQuery.isLoading.value,
);
const diagramError = computed(() => allAgentsQuery.isError.value || statusesQuery.isError.value);

// Лукап по id — через detail-эндпоинт, не через пагинированный список.
const workspaceQuery = useWorkspace(props.id);
const repositories = computed(() => workspaceQuery.data.value?.repositories ?? []);

// feature 016: executor_id → profile NAME. Потребитель всего списка — не листает
// (конвенция 2026-07-15); executors платформенные и немногочисленные. Пока список
// не загружен (или упал) — мапа пуста, ячейки Executor просто пустые.
const executorsQuery = useExecutors({ page: 1, page_size: MAX_PAGE_SIZE });
const executorNames = computed(
  () => new Map((executorsQuery.data.value?.items ?? []).map((e) => [e.id, e.name])),
);

const deleteAgent = useDeleteAgent(props.id);

// --- feature 011: "Generate agents" — offered while the roster is
// orchestrator-only and no setup run is active. The setup run's state rides
// the runs query (existing 5 s poll), filtered by trigger source.
const setupRunsQuery = useRuns(props.id, { source: 'workspace-setup', page_size: 10 });
const activeSetupRun = computed(() =>
  (setupRunsQuery.data.value?.items ?? []).find((r) =>
    ['queued', 'running', 'awaiting_human'].includes(r.status),
  ),
);
const rosterIsOrchestratorOnly = computed(
  () =>
    !agentsQuery.isLoading.value &&
    (agentsQuery.data.value?.items ?? []).every((a) => a.is_orchestrator) ,
);
const showGenerate = computed(() => rosterIsOrchestratorOnly.value && total.value <= 1);
const generateAgents = useGenerateAgents(props.id);

async function onGenerate() {
  try {
    await generateAgents.mutateAsync();
    ElMessage.success('Workspace setup started — the orchestrator is studying the project.');
  } catch (err) {
    const code = err instanceof ApiError ? err.code : undefined;
    ElMessage.error(
      code === 'setup_run_active'
        ? 'A setup run is already in progress.'
        : code === 'worker_agents_exist'
          ? 'This workspace already has worker agents.'
          : 'Could not start workspace setup.',
    );
  }
}

const showForm = ref(false);
const editing = ref<AgentResponse | null>(null);
const agentFormRef = ref<InstanceType<typeof AgentForm>>();

// feature 018 (US2): trigger_status seed for a create opened from a diagram
// status node's "+". Cleared on the next PLAIN "New agent" open (not on dialog
// close — clearing there would re-key the form mid-close-transition).
const createTriggerStatus = ref<string | null>(null);

function openCreate() {
  createTriggerStatus.value = null;
  editing.value = null;
  showForm.value = true;
}

function openCreateFromStatus(statusName: string) {
  createTriggerStatus.value = statusName;
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
      <div class="header-actions">
        <!-- feature 018: List/Diagram toggle. Static lucide icons (hover
             animation is sidebar-only). -->
        <el-segmented v-model="mode" :options="modeOptions" data-test="view-mode-toggle">
          <template #default="{ item }">
            <span class="mode-option">
              <component :is="item.icon" :size="14" />
              <span>{{ item.label }}</span>
            </span>
          </template>
        </el-segmented>
        <!-- feature 011: one-click team generation for an empty workspace. -->
        <template v-if="showGenerate">
          <router-link
            v-if="activeSetupRun"
            :to="`/runs/${activeSetupRun.run_id}`"
            data-test="setup-run-link"
          >
            <el-button loading data-test="generate-agents-progress">
              Generating team…
            </el-button>
          </router-link>
          <el-button
            v-else
            data-test="generate-agents"
            :loading="generateAgents.isPending.value"
            @click="onGenerate"
          >
            Generate agents
          </el-button>
        </template>
        <el-button type="primary" data-test="new-agent" @click="openCreate">
          New agent
        </el-button>
      </div>
    </div>

    <FormDialog v-model="showForm" :title="editing ? 'Edit agent' : 'New agent'">
      <!-- feature 018: the key carries the prefill so consecutive "+" clicks
           on different statuses re-seed a fresh form. -->
      <AgentForm
        v-if="showForm"
        ref="agentFormRef"
        :key="editing?.id ?? `new:${createTriggerStatus ?? ''}`"
        :workspace-id="id"
        :agent="editing"
        :repositories="repositories"
        :initial-trigger-status="createTriggerStatus ?? undefined"
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

    <!-- feature 018: Diagram mode — same data layer, different projection.
         The queries live in this view's setup, so v-if here swaps DOM only. -->
    <AgentsDiagram
      v-if="mode === 'diagram'"
      :agents="diagramAgents"
      :statuses="diagramStatuses"
      :loading="diagramLoading"
      :error="diagramError"
      @create-agent="openCreateFromStatus"
      @edit-agent="openEdit"
    />

    <el-table
      v-if="mode === 'list'"
      v-loading="agentsQuery.isLoading.value"
      :data="agentsQuery.data.value?.items ?? []"
      data-test="agents-table"
    >
      <el-table-column label="Name" min-width="140">
        <template #default="{ row }">
          <span>{{ row.name }}</span>
        </template>
      </el-table-column>
      <!-- feature 016: role as its own tagged column; "teamlead" for the orchestrator. -->
      <el-table-column label="Role" min-width="110">
        <template #default="{ row }">
          <el-tag v-if="row.role" size="small" data-test="agent-role-tag">{{ row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Key" min-width="130">
        <template #default="{ row }">
          <code class="agent-key" data-test="agent-key">{{ row.key }}</code>
        </template>
      </el-table-column>
      <!-- feature 016: executor profile name; empty when the id resolves to nothing. -->
      <el-table-column label="Executor" min-width="110">
        <template #default="{ row }">
          <span v-if="executorNames.get(row.executor_id)" data-test="agent-executor">
            {{ executorNames.get(row.executor_id) }}
          </span>
        </template>
      </el-table-column>
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
          <!-- feature 010 (FR-019): the orchestrator is non-deletable — disable it instead. -->
          <el-button v-if="!row.is_orchestrator" link type="danger" @click="onDelete(row)">Delete</el-button>
        </template>
      </el-table-column>
    </el-table>

    <ListPagination
      v-if="mode === 'list'"
      :total="total"
      v-model:page="page"
      v-model:page-size="pageSize"
    />
  </section>
</template>

<style scoped lang="scss">
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.agent-key {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.mode-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>

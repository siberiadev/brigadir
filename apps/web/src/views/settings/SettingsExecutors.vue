<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { ExecutorResponse } from '@brigadir/contracts';
import { useExecutors, useDeleteExecutor } from '../../composables/useExecutors';
import { usePagination } from '../../composables/usePagination';
import { ApiError } from '../../api/client';
import ExecutorForm from '../../components/ExecutorForm/ExecutorForm.vue';
import FormDialog from '../../components/FormDialog.vue';
import ListPagination from '../../components/ListPagination.vue';

/**
 * Executors panel of the platform Settings page (2026-07-13). The executors
 * admin moved here VERBATIM from the workspace Settings tab — table +
 * ExecutorForm modal — now against the global `/api/executors` surface and
 * without the repository field (repository is an agent choice).
 */
const { page, pageSize, params, bindTotal } = usePagination();
const executorsQuery = useExecutors(params);
const total = computed(() => executorsQuery.data.value?.total ?? 0);
bindTotal(total);
const deleteExecutor = useDeleteExecutor();
const showExecutorForm = ref(false);
const editingExecutor = ref<ExecutorResponse | null>(null);
const executorFormRef = ref<InstanceType<typeof ExecutorForm>>();

function openCreateExecutor() {
  editingExecutor.value = null;
  showExecutorForm.value = true;
}
function openEditExecutor(ex: ExecutorResponse) {
  editingExecutor.value = ex;
  showExecutorForm.value = true;
}
function onExecutorSaved() {
  showExecutorForm.value = false;
  ElMessage.success('Executor saved.');
}
async function onDeleteExecutor(ex: ExecutorResponse) {
  try {
    await deleteExecutor.mutateAsync(ex.id);
    ElMessage.success('Executor deleted.');
  } catch (err) {
    // 409 executor_in_use names the referencing agents — surface it verbatim.
    const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Delete failed.';
    ElMessage.error(msg);
  }
}
</script>

<template>
  <div class="block" data-test="settings-executors-block">
    <div class="block-head">
      <h3>Executors</h3>
      <el-button type="primary" data-test="new-executor" @click="openCreateExecutor">
        New executor
      </el-button>
    </div>

    <!-- Named runner profiles (2026-07-14): Type → Model → Name → limits → key → enabled. -->
    <el-table
      v-loading="executorsQuery.isLoading.value"
      :data="executorsQuery.data.value?.items ?? []"
      data-test="executors-table"
    >
      <el-table-column label="Type" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.type === 'claude_cli' ? 'primary' : 'info'">
            {{ row.type }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Model">
        <template #default="{ row }">
          <span data-test="executor-model-cell">{{ row.config.model ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="Name">
        <template #default="{ row }">
          <span data-test="executor-name-cell">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="max_parallel_runs" label="Max parallel runs" width="150" />
      <el-table-column label="API key" width="100">
        <template #default="{ row }">
          <span data-test="executor-api-key-cell">{{ row.has_api_key ? 'set' : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="Enabled" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.enabled ? 'success' : 'info'" data-test="executor-enabled-cell">
            {{ row.enabled ? 'enabled' : 'disabled' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="">
        <template #default="{ row }">
          <el-button link type="primary" :data-test="`executor-edit-${row.id}`" @click="openEditExecutor(row)">
            Edit
          </el-button>
          <el-button link type="danger" :data-test="`executor-delete-${row.id}`" @click="onDeleteExecutor(row)">
            Delete
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <ListPagination :total="total" v-model:page="page" v-model:page-size="pageSize" />

    <!-- Executor create/edit -->
    <FormDialog v-model="showExecutorForm" :title="editingExecutor ? 'Edit executor' : 'New executor'">
      <ExecutorForm
        v-if="showExecutorForm"
        ref="executorFormRef"
        :key="editingExecutor?.id ?? 'new'"
        :executor="editingExecutor"
        @saved="onExecutorSaved"
      />
      <template #footer>
        <el-button data-test="executor-cancel" @click="showExecutorForm = false">Cancel</el-button>
        <el-button
          type="primary"
          data-test="executor-save"
          :loading="executorFormRef?.saving"
          @click="executorFormRef?.submit()"
        >
          {{ editingExecutor ? 'Save' : 'Create executor' }}
        </el-button>
      </template>
    </FormDialog>
  </div>
</template>

<style scoped lang="scss">
.block {
  max-width: 960px;
}
.block h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
</style>

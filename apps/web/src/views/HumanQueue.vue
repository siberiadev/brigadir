<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { HumanQueueItem, HumanQueueStatus, ResolveHumanTaskInput } from '@brigadir/contracts';
import { useHumanTasks, useResolveHumanTask } from '../composables/useHumanTasks';
import { usePagination } from '../composables/usePagination';
import { formatDateTime } from '../utils/date';
import { ApiError } from '../api/client';
import ListPagination from '../components/ListPagination.vue';
import HumanTaskRow from '../components/HumanQueue/HumanTaskRow.vue';
import HumanTaskDrawer from '../components/HumanQueue/HumanTaskDrawer.vue';
import ResumeAgentPicker from '../components/ResumeAgentPicker.vue';

// The global (cross-workspace) needs-human queue (US1). Open tasks are
// oldest-first (longest-waiting on top); history shows the closed tasks with
// their resolution + resolver. Live via the composable's refetchInterval.
// Одна пагинация на оба таба: переключение таба = смена фильтра → страница 1.
const filter = ref<HumanQueueStatus>('open');
const { page, pageSize, params, bindTotal } = usePagination({ resetOn: filter });
const queue = useHumanTasks('open', params);
const closedQueue = useHumanTasks('closed', params);

const activeQuery = computed(() => (filter.value === 'open' ? queue : closedQueue));
const items = computed<HumanQueueItem[]>(() => activeQuery.value.data.value?.items ?? []);
const total = computed(() => activeQuery.value.data.value?.total ?? 0);
bindTotal(total);

// Detail drawer: the selected task is looked up from the live list so the 4s
// poll keeps the drawer content fresh (placeholderData avoids flicker).
const selectedId = ref('');
const selectedItem = computed(
  () => items.value.find((i) => i.id === selectedId.value) ?? null,
);
const drawerOpen = computed({
  get: () => !!selectedItem.value,
  set: (open) => {
    if (!open) selectedId.value = '';
  },
});

// Per-task resolution form state, keyed by task id. Drafts survive closing the
// drawer without submitting — reopening the task restores the typed answer.
type Draft = { action: ResolveHumanTaskInput['action']; answer: string; targetAgentId?: string };
const drafts = reactive<Record<string, Draft>>({});
function draftFor(id: string): Draft {
  if (!drafts[id]) drafts[id] = { action: 'resume', answer: '' };
  return drafts[id];
}

const resolve = useResolveHumanTask();
const submittingId = ref('');

// If the selected task vanished from the list without us resolving it (someone
// else did, or it left this page), close the drawer and say why. Our own
// submit clears selectedId before the invalidated refetch lands, and the
// submittingId guard covers the in-flight window, so this never fires then.
watch(selectedItem, (item) => {
  if (
    !item &&
    selectedId.value &&
    !submittingId.value &&
    !activeQuery.value.isLoading.value
  ) {
    selectedId.value = '';
    ElMessage.info('Task was resolved elsewhere.');
  }
});

async function submit(item: HumanQueueItem) {
  const draft = draftFor(item.id);
  submittingId.value = item.id;
  try {
    const body: ResolveHumanTaskInput = { action: draft.action };
    if (draft.answer.trim()) body.answer = draft.answer.trim();
    // FR-015: a resume can target a different worker agent. Only send it when it
    // actually differs from the run's original agent.
    if (
      draft.action === 'resume' &&
      draft.targetAgentId &&
      draft.targetAgentId !== item.agent?.id
    ) {
      body.target_agent_id = draft.targetAgentId;
    }
    await resolve.mutateAsync({ id: item.id, body });
    delete drafts[item.id];
    selectedId.value = '';
    ElMessage.success(
      draft.action === 'resume'
        ? 'Task answered — run resumed.'
        : draft.action === 'done_manually'
          ? 'Task marked done.'
          : 'Task dismissed.',
    );
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Resolve failed.';
    ElMessage.error(msg);
  } finally {
    submittingId.value = '';
  }
}
</script>

<template>
  <section class="human-queue">
    <div class="header-row">
      <h2>Needs-human queue</h2>
      <el-radio-group v-model="filter" data-test="queue-filter">
        <el-radio-button label="open" value="open">Open</el-radio-button>
        <el-radio-button label="closed" value="closed">History</el-radio-button>
      </el-radio-group>
    </div>

    <el-empty
      v-if="!activeQuery.isLoading.value && items.length === 0"
      :description="filter === 'open' ? 'Nothing needs a human right now.' : 'No resolved tasks yet.'"
      data-test="queue-empty"
    />

    <ul v-else v-loading="activeQuery.isLoading.value" class="task-list" data-test="task-list">
      <HumanTaskRow
        v-for="item in items"
        :key="item.id"
        :item="item"
        @select="selectedId = $event"
      />
    </ul>

    <HumanTaskDrawer v-model="drawerOpen" :item="selectedItem">
      <template #footer="{ item }">
        <!-- open: resolution form -->
        <div v-if="filter === 'open'" class="resolve-form">
          <el-input
            v-model="draftFor(item.id).answer"
            type="textarea"
            :rows="4"
            placeholder="Answer / note (optional)"
            :data-test="`answer-${item.id}`"
          />
          <!-- FR-017: on a blocking task, choose which enabled worker agent resumes. -->
          <ResumeAgentPicker
            v-if="item.blocking && draftFor(item.id).action === 'resume'"
            v-model="draftFor(item.id).targetAgentId"
            :workspace-id="item.workspace.id"
            :original-agent-id="item.agent?.id ?? null"
            :task-id="item.id"
          />
          <div class="form-actions">
            <el-radio-group v-model="draftFor(item.id).action" :data-test="`action-${item.id}`">
              <el-radio value="resume">Resume</el-radio>
              <el-radio value="done_manually">Done manually</el-radio>
              <el-radio value="dismiss">Dismiss</el-radio>
            </el-radio-group>
            <el-button
              type="primary"
              :loading="submittingId === item.id"
              :data-test="`resolve-${item.id}`"
              @click="submit(item)"
            >
              Submit
            </el-button>
          </div>
        </div>

        <!-- closed: resolution summary -->
        <div v-else class="drawer-resolution" data-test="drawer-resolution">
          <el-tag size="small" :type="item.status === 'resolved' ? 'success' : 'info'">
            {{ item.status }}
          </el-tag>
          <span v-if="item.resolution" class="resolution-text">{{ item.resolution }}</span>
          <span v-if="item.resolved_by" class="muted">· by {{ item.resolved_by }}</span>
          <span v-if="item.resolved_at" class="muted">· {{ formatDateTime(item.resolved_at) }}</span>
        </div>
      </template>
    </HumanTaskDrawer>

    <ListPagination :total="total" v-model:page="page" v-model:page-size="pageSize" />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.task-list {
  list-style: none;
  margin: 0;
  padding: 0;

  > :deep(li + li) {
    border-top: 1px solid var(--el-border-color-lighter);
  }
}
.resolve-form {
  display: flex;
  flex-direction: column;
  gap: $space-sm;
}
.form-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer-resolution {
  display: flex;
  align-items: center;
  gap: $space-sm;
  flex-wrap: wrap;
}
.resolution-text {
  color: var(--el-text-color-regular);
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>

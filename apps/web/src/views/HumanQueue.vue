<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { HumanQueueItem, HumanQueueStatus, ResolveHumanTaskInput } from '@brigadir/contracts';
import { useHumanTasks, useResolveHumanTask } from '../composables/useHumanTasks';
import { relativeAge } from '../utils/date';
import { ApiError } from '../api/client';

// The global (cross-workspace) needs-human queue (US1). Open tasks are
// oldest-first (longest-waiting on top); history shows the closed tasks with
// their resolution + resolver. Live via the composable's refetchInterval.
const filter = ref<HumanQueueStatus>('open');
const queue = useHumanTasks('open');
const closedQueue = useHumanTasks('closed');

const activeQuery = computed(() => (filter.value === 'open' ? queue : closedQueue));
const items = computed<HumanQueueItem[]>(() => activeQuery.value.data.value?.items ?? []);

// Per-task resolution form state, keyed by task id.
type Draft = { action: ResolveHumanTaskInput['action']; answer: string };
const drafts = reactive<Record<string, Draft>>({});
function draftFor(id: string): Draft {
  if (!drafts[id]) drafts[id] = { action: 'resume', answer: '' };
  return drafts[id];
}

const resolve = useResolveHumanTask();
const submittingId = ref('');

async function submit(item: HumanQueueItem) {
  const draft = draftFor(item.id);
  submittingId.value = item.id;
  try {
    const body: ResolveHumanTaskInput = { action: draft.action };
    if (draft.answer.trim()) body.answer = draft.answer.trim();
    await resolve.mutateAsync({ id: item.id, body });
    delete drafts[item.id];
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

const kindTagType: Record<string, string> = {
  blocker: 'danger',
  question: 'warning',
  review: 'info',
};
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

    <div v-else v-loading="activeQuery.isLoading.value" class="task-list" data-test="task-list">
      <el-card
        v-for="item in items"
        :key="item.id"
        class="task"
        :data-test="`task-${item.id}`"
      >
        <div class="task-head">
          <el-tag :type="kindTagType[item.kind] ?? 'info'" size="small">{{ item.kind }}</el-tag>
          <el-tag v-if="item.blocking" type="danger" size="small" data-test="blocking-flag">blocking</el-tag>
          <span class="title" data-test="task-title">{{ item.title }}</span>
          <span class="spacer" />
          <a :href="item.ticket.jira_url" target="_blank" rel="noopener" data-test="task-ticket">
            {{ item.ticket.key }}
          </a>
          <span v-if="item.agent" class="muted">· {{ item.agent.name }}</span>
          <span class="muted" data-test="task-age">· {{ relativeAge(item.created_at) }} ago</span>
        </div>

        <p v-if="item.details" class="details">{{ item.details }}</p>

        <!-- open: resolution form -->
        <template v-if="filter === 'open'">
          <el-input
            v-model="draftFor(item.id).answer"
            type="textarea"
            :rows="2"
            placeholder="Answer / note (optional)"
            :data-test="`answer-${item.id}`"
          />
          <div class="task-actions">
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
        </template>

        <!-- closed: resolution summary -->
        <div v-else class="resolution" :data-test="`resolution-${item.id}`">
          <el-tag size="small" :type="item.status === 'resolved' ? 'success' : 'info'">
            {{ item.status }}
          </el-tag>
          <span v-if="item.resolution" class="resolution-text">{{ item.resolution }}</span>
          <span v-if="item.resolved_by" class="muted" :data-test="`resolver-${item.id}`">
            · by {{ item.resolved_by }}
          </span>
        </div>
      </el-card>
    </div>
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
  display: flex;
  flex-direction: column;
  gap: $space-md;
}
.task-head {
  display: flex;
  align-items: center;
  gap: $space-sm;
}
.title {
  font-weight: $font-weight-medium;
}
.spacer {
  flex: 1;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.details {
  margin: $space-sm 0;
  color: var(--el-text-color-regular);
}
.task-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: $space-sm;
}
.resolution {
  display: flex;
  align-items: center;
  gap: $space-sm;
}
.resolution-text {
  color: var(--el-text-color-regular);
}
</style>

<script setup lang="ts">
/**
 * Per-workspace health cards (feature 017, US5): one batched request for the
 * whole grid — never a request per card (FR-020). Paused workspaces render
 * muted with a "paused" tag; a 24h failure count renders a danger marker.
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { HomeWorkspaceItem } from '@brigadir/contracts';
import { useHomeWorkspaces } from '../../composables/useHomeWorkspaces';
import RunStatusTag from '../RunStatusTag.vue';
import { relativeAge } from '../../utils/date';

const router = useRouter();
const wsQuery = useHomeWorkspaces();
const items = computed<HomeWorkspaceItem[]>(() => wsQuery.data.value?.items ?? []);

function lastRunWhen(item: HomeWorkspaceItem): string {
  const run = item.last_run;
  if (!run) return '';
  return `${relativeAge(run.finished_at ?? run.started_at ?? run.created_at)} ago`;
}

function openWorkspace(item: HomeWorkspaceItem) {
  router.push({ name: 'runs', params: { id: item.id } });
}
</script>

<template>
  <section class="ws-section" data-test="workspace-grid">
    <div class="section-head">
      <h3>Workspaces</h3>
      <RouterLink to="/workspaces" class="head-link" data-test="grid-all-workspaces">
        All workspaces →
      </RouterLink>
    </div>

    <div v-if="wsQuery.isError.value" class="block-error" data-test="grid-error">
      Couldn't load workspaces — retrying.
    </div>
    <el-empty
      v-else-if="!wsQuery.isLoading.value && items.length === 0"
      description="No workspaces yet — create one to get started."
      :image-size="48"
      data-test="grid-empty"
    />
    <div v-else class="grid">
      <el-card
        v-for="item in items"
        :key="item.id"
        class="ws-card"
        :class="{ paused: !item.enabled }"
        shadow="never"
        data-test="ws-card"
        @click="openWorkspace(item)"
      >
        <div class="ws-top">
          <span class="ws-name">{{ item.name }}</span>
          <span class="ws-board">{{ item.project_key }}</span>
          <el-tag
            :type="item.enabled ? 'success' : 'info'"
            size="small"
            class="state-tag"
            data-test="ws-state"
          >
            {{ item.enabled ? 'active' : 'paused' }}
          </el-tag>
        </div>
        <div class="ws-meta">
          {{ item.agent_count }} agents ·
          <template v-if="item.last_run">
            last run
            <RunStatusTag :status="item.last_run.status" size="small" />
            {{ lastRunWhen(item) }}
          </template>
          <span v-else data-test="ws-no-runs">no runs yet</span>
        </div>
        <span v-if="item.attention_24h > 0" class="ws-alert" data-test="ws-alert">
          <span class="dot" aria-hidden="true" />
          {{ item.attention_24h }} failed in last 24h
        </span>
        <span v-else class="ws-ok" data-test="ws-ok">no failures in last 24h</span>
      </el-card>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $space-md;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}
.head-link {
  font-size: 13px;
  color: var(--el-color-primary);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: $space-lg;

  @media (max-width: 1080px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  @media (max-width: 760px) {
    grid-template-columns: 1fr;
  }
}
.ws-card {
  cursor: pointer;

  &.paused {
    opacity: 0.75;
  }
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: $space-sm;
  }
}
.ws-top {
  display: flex;
  align-items: center;
  gap: $space-sm;
  min-width: 0;
}
.ws-name {
  font-weight: $font-weight-medium;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-board {
  font-family: $font-family-mono;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.state-tag {
  margin-left: auto;
  flex: none;
}
.ws-meta {
  font-size: 12.5px;
  color: var(--el-text-color-regular);
}
.ws-alert {
  display: inline-flex;
  align-items: center;
  gap: $space-xs;
  font-size: 12px;
  font-weight: $font-weight-medium;
  color: var(--el-color-danger);

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--el-color-danger);
  }
}
.ws-ok {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.block-error {
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>

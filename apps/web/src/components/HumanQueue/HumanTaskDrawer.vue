<script setup lang="ts">
import type { HumanQueueItem } from '@brigadir/contracts';
import MarkdownText from '../MarkdownText.vue';
import { relativeAge } from '../../utils/date';
import { kindTagType } from './kindTag';

/**
 * Right-side detail drawer for a needs-human task: fixed header (tags, full
 * title, ticket/agent/workspace/age), scrollable markdown body, and a #footer
 * slot the parent fills with the resolve form (open) or resolution (closed).
 * Presentational only — mirroring FormDialog, all form state stays in the
 * parent, which also lets drafts survive a close: unlike FormDialog we keep
 * `close-on-click-modal` at its default (true) since nothing is lost.
 * `append-to-body` stays false so the drawer DOM lives in the component
 * subtree (tests use wrapper.find); the fixed overlay covers the viewport
 * regardless. `destroy-on-close` bounds ResumeAgentPicker's per-instance
 * agents query to the drawer's lifetime.
 */
defineProps<{ item: HumanQueueItem | null }>();

const visible = defineModel<boolean>({ required: true });
</script>

<template>
  <el-drawer v-model="visible" size="600px" destroy-on-close>
    <template #header>
      <div v-if="item" class="drawer-header" data-test="drawer-header">
        <div class="tags">
          <el-tag :type="kindTagType[item.kind] ?? 'info'" size="small">{{ item.kind }}</el-tag>
        </div>
        <h3 class="drawer-title">{{ item.title }}</h3>
        <div class="meta">
          <!-- feature 011: ticketless setup tasks get a label, no link. -->
          <a v-if="item.ticket" :href="item.ticket.jira_url" target="_blank" rel="noopener" data-test="drawer-ticket">
            {{ item.ticket.key }}
          </a>
          <span v-else data-test="drawer-setup-label">Workspace setup</span>
          <span v-if="item.agent">· {{ item.agent.name }}</span>
          <span>· {{ item.workspace.name }}</span>
          <span data-test="drawer-age">· {{ relativeAge(item.created_at) }} ago</span>
        </div>
        <!-- A blocking, still-open task parked its run; resolving resumes it. -->
        <p v-if="item.blocking && !item.status" class="parked-note" data-test="parked-note">
          ⏸ Run parked until resolved
        </p>
      </div>
    </template>

    <template v-if="item">
      <MarkdownText v-if="item.details" :source="item.details" data-test="task-details" />
      <p v-else class="no-details" data-test="drawer-no-details">No details provided.</p>
    </template>

    <template #footer>
      <slot v-if="item" name="footer" :item="item" />
    </template>
  </el-drawer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// The default 32px header margin fights the multi-line header block.
:deep(.el-drawer__header) {
  margin-bottom: 0;
}
:deep(.el-drawer__footer) {
  text-align: left;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: $space-md;
}
.drawer-header {
  display: flex;
  flex-direction: column;
  gap: $space-xs;
  min-width: 0;
}
.tags {
  display: flex;
  gap: $space-xs;
}
.parked-note {
  margin: 0;
  font-size: 13px;
  font-weight: $font-weight-medium;
  color: var(--el-color-danger);
}
.drawer-title {
  margin: 0;
  font-size: 16px;
  font-weight: $font-weight-medium;
  color: var(--el-text-color-primary);
  word-break: break-word;
}
.meta {
  display: flex;
  align-items: center;
  gap: $space-xs;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.no-details {
  margin: 0;
  color: var(--el-text-color-secondary);
}
</style>

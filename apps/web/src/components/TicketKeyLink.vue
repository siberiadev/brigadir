<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';

/**
 * Ticket key rendered as an INTERNAL link (the ticket-history page) with a
 * small static icon next to it that opens the ticket in Jira in a new tab.
 * Both stop click propagation — the key often sits inside a clickable row.
 * Icon is STATIC — hover icon animation is sidebar-only (CLAUDE.md).
 */
withDefaults(
  defineProps<{ workspaceId: string; ticketKey: string; jiraUrl?: string | null }>(),
  { jiraUrl: null },
);
</script>

<template>
  <span class="ticket-key-link">
    <router-link
      :to="{ name: 'ticket-history', params: { id: workspaceId, key: ticketKey } }"
      data-test="ticket-link"
      @click.stop
    >
      {{ ticketKey }}
    </router-link>
    <a
      v-if="jiraUrl"
      :href="jiraUrl"
      target="_blank"
      rel="noopener"
      class="jira-icon"
      :aria-label="`Open ${ticketKey} in Jira`"
      title="Open in Jira"
      data-test="ticket-jira-icon"
      @click.stop
    >
      <ExternalLink :size="12" />
    </a>
  </span>
</template>

<style scoped lang="scss">
.ticket-key-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.jira-icon {
  display: inline-flex;
  align-items: center;
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-color-primary);
  }
}
</style>

import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

// architecture.md §3 — tickets (last_seen_* are a diff cache, NOT source of truth)
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jiraKey: text('jira_key').notNull(),
    jiraId: text('jira_id').notNull(),
    summary: text('summary'),
    lastSeenStatus: text('last_seen_status'),
    lastSeenUpdated: timestamp('last_seen_updated', { withTimezone: true }),
  },
  (t) => [unique('tickets_workspace_key').on(t.workspaceId, t.jiraKey)],
);

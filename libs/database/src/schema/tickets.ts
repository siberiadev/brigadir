import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, unique, integer, jsonb } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

// architecture.md §3 — tickets (last_seen_*, priority_*, blocked_* are a diff
// cache of observed Jira data, NOT source of truth)
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
    // feature 022: Jira priority cache — ascending id = more important
    // (built-in scheme: 1 Highest … 5 Lowest); NULL = no/unparseable priority.
    priorityId: integer('priority_id'),
    priorityName: text('priority_name'),
    // feature 022: sequencing waiting cache — open inward "is blocked by" keys
    // (string[]) and the classification; both NULL when not blocked-waiting.
    blockedBy: jsonb('blocked_by'),
    // waiting | cycle | dead_end | out_of_scope
    blockedState: text('blocked_state'),
    // feature 033: sha-anchored verification receipt (VerificationReceiptSchema)
    // written on callback complete with measured observed heads; whole-replace,
    // never cleared — a stale receipt self-invalidates by sha mismatch.
    verification: jsonb('verification'),
  },
  (t) => [unique('tickets_workspace_key').on(t.workspaceId, t.jiraKey)],
);

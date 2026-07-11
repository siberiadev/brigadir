import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { bytea } from './_custom';

// architecture.md §3 — workspaces (implemented as-is).
// Iteration 2 (migration 0001): jira_board_id / jira_board_type — the board
// binding; type is introspected via the Agile API at connect time.
export const workspaces = pgTable('workspaces', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  jiraSiteUrl: text('jira_site_url').notNull(),
  jiraProjectKey: text('jira_project_key').notNull(),
  jiraBoardId: integer('jira_board_id'),
  jiraBoardType: text('jira_board_type'), // 'kanban' | 'scrum'
  jiraAuthType: text('jira_auth_type').notNull().default('api_token'),
  jiraCredentials: bytea('jira_credentials').notNull(),
  jiraCredentialExpiresAt: timestamp('jira_credential_expires_at', { withTimezone: true }),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

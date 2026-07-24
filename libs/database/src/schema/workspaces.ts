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
  // Feature 030 (migration 0009): sealed access token for a PRIVATE agent
  // role-template repo (AES-256-GCM secret-box, same key/codec as
  // jira_credentials). NULL = no token. Write-only over the API (responses
  // expose only has_agent_instructions_token). The non-secret url/ref/subdir
  // live in `settings.agent_instructions`.
  agentInstructionsToken: bytea('agent_instructions_token'),
  // Feature 031 (migration 0010): sealed per-workspace env-secrets document
  // (AES-256-GCM secret-box, same key/codec as jira_credentials). NULL = no
  // secret env configured. Holds a JSON doc { workspace?, repos?, agents? } of
  // secret env values across all three scopes. WRITE-ONLY over the API
  // (responses expose only key NAMES via env_secret_keys). Non-secret env
  // lives openly in `settings.env` / `settings.repositories[].env` /
  // `agents.behavior.env`.
  envSecrets: bytea('env_secrets'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

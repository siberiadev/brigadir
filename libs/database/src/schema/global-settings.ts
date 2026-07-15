import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/**
 * architecture.md §3 — global_settings (feature 010). Platform-global key-value
 * store (no workspace FK) backing the "General" settings section (FR-021). First
 * key: `default_orchestrator_instruction` (a JSON string), read at
 * workspace-creation time and copied into the seeded orchestrator (FR-022).
 */
export const globalSettings = pgTable('global_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

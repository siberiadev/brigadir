import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer } from 'drizzle-orm/pg-core';
import { runs } from './runs';

// architecture.md §3 — run_checks (checklist UI source); status: pass | fail | skip | warn
export const runChecks = pgTable('run_checks', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),
});

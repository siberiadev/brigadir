import { pgTable, uuid, text, jsonb, timestamp, bigint, index } from 'drizzle-orm/pg-core';
import { runs } from './runs';

// architecture.md §3 — run_events (run timeline).
// type: progress | log | tool_call | api_retry | error | jira_action
export const runEvents = pgTable(
  'run_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_events_run').on(t.runId, t.id)],
);

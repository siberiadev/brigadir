import { pgTable, uuid, text, jsonb, timestamp, bigint, index } from 'drizzle-orm/pg-core';
import { runs } from './runs';

// architecture.md §3 — run_events (run timeline).
// type: progress | log | tool_call | api_retry | error | jira_action
//       | undelivered_report | channel_down (feature 026)
//       | channel_failure (feature 027 — доставка callback'а исчерпала ретраи)
//       | tool_denied (token-spend problem 1 — PreToolUse bash-guard отклонил
//         sleep-ожидание; payload {name, command?, reason, truncated})
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

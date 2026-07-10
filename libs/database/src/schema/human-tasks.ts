import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { runs } from './runs';
import { tickets } from './tickets';

// architecture.md §3 — human_tasks (the "needs a person" queue).
// kind: question | blocker | review; status: open | resolved | dismissed
export const humanTasks = pgTable(
  'human_tasks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    runId: uuid('run_id').references(() => runs.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    details: text('details'),
    blocking: boolean('blocking').notNull().default(true),
    status: text('status').notNull().default('open'),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
  },
  (t) => [
    index('human_tasks_open')
      .on(t.workspaceId, t.status)
      .where(sql`status = 'open'`),
  ],
);

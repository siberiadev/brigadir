import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, index, jsonb } from 'drizzle-orm/pg-core';
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
    // Nullable since feature 011: workspace-setup review/failure/question tasks
    // carry no ticket (contracts/nullable-ticket.md).
    ticketId: uuid('ticket_id').references(() => tickets.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    details: text('details'),
    // Suggested answer options (feature 013): scrubbed AnswerOption[] (1–5) or
    // NULL — for system-composed tasks and every ask without options. Written
    // once at creation, never updated; validated by zod at intake, not in SQL.
    options: jsonb('options'),
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

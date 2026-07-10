import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { tickets } from './tickets';
import { agents } from './agents';

// architecture.md §3 — runs.
// status: queued | running | awaiting_human | succeeded | failed | cancelled | timed_out | superseded
export const runs = pgTable(
  'runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    executorType: text('executor_type').notNull(),
    status: text('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(1),
    triggerEvent: jsonb('trigger_event'),
    externalRef: text('external_ref'),
    worktreePath: text('worktree_path'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    usage: jsonb('usage'),
    error: text('error'),
    report: jsonb('report'),
    outcome: text('outcome'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Third idempotency level: one active run per (ticket, agent).
    uniqueIndex('runs_one_active')
      .on(t.ticketId, t.agentId)
      .where(sql`status IN ('queued', 'running', 'awaiting_human')`),
    index('runs_ticket').on(t.ticketId, t.createdAt.desc()),
  ],
);

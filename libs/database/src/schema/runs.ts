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
    // Nullable since feature 011: workspace-setup runs carry no ticket. Every
    // read path left-joins tickets and tolerates null (contracts/nullable-ticket.md).
    ticketId: uuid('ticket_id').references(() => tickets.id),
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
    // Feature 011 (D3): unique-index NULLs are distinct, so `runs_one_active`
    // cannot guard ticketless rows — this companion index allows at most ONE
    // active ticketless (workspace-setup) run per workspace.
    uniqueIndex('runs_one_active_setup')
      .on(t.workspaceId)
      .where(sql`status IN ('queued', 'running', 'awaiting_human') AND ticket_id IS NULL`),
    index('runs_ticket').on(t.ticketId, t.createdAt.desc()),
    // Feature 006 (data-model additive item 1): supports the workspace-scoped,
    // time-ordered runs table read + the cost period sum. Non-structural.
    index('runs_workspace_created').on(t.workspaceId, t.createdAt.desc()),
  ],
);

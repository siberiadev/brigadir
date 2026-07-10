import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  numeric,
  unique,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { executors } from './executors';

// architecture.md §3 — agents (implemented as-is)
export const agents = pgTable(
  'agents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    executorId: uuid('executor_id')
      .notNull()
      .references(() => executors.id),
    name: text('name').notNull(),
    instruction: text('instruction').notNull(),
    triggerStatus: text('trigger_status'),
    triggerJql: text('trigger_jql'),
    statusRunning: text('status_running'),
    statusSuccess: text('status_success').notNull(),
    statusFailure: text('status_failure').notNull(),
    behavior: jsonb('behavior').notNull().default({}),
    timeoutMinutes: integer('timeout_minutes').notNull().default(45),
    maxBudgetUsd: numeric('max_budget_usd', { precision: 8, scale: 2 }),
    maxAttempts: integer('max_attempts').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique('agents_workspace_name').on(t.workspaceId, t.name)],
);

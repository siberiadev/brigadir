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
    // feature 014: presentation persona ("Achilles", "Hera"), editable, NO
    // LONGER unique — identity is `id`, the LLM/UI handle is `key`.
    name: text('name').notNull(),
    // feature 014: the agent's function ("Developer", "QA", "Reviewer";
    // orchestrator = "teamlead"). Editable, nullable (backfilled rows have none).
    role: text('role'),
    // feature 014: readable, workspace-unique HANDLE at the LLM/UI boundary
    // (routing, URLs, logs). System-generated ONCE at creation via
    // slugifyAgentKey(name, role); IMMUTABLE — never recomputed on edit, resolved
    // to `id` at the boundary. Reserved key "brigadir" belongs to the orchestrator.
    key: text('key').notNull(),
    // Roster line shown to the orchestrator in the handoff (FR-020). Nullable.
    description: text('description'),
    instruction: text('instruction').notNull(),
    // Marks the per-workspace orchestrator ("brigadir"): never poll-triggered,
    // non-deletable, excluded from routing targets and the resume picker
    // (FR-018/019). Explicit column (not a behavior flag) so it's queryable.
    isOrchestrator: boolean('is_orchestrator').notNull().default(false),
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
  // feature 014: identity is (workspace_id, key); `name` may now repeat.
  (t) => [unique('agents_workspace_key').on(t.workspaceId, t.key)],
);

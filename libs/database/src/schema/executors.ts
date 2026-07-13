import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, integer, boolean, unique } from 'drizzle-orm/pg-core';
import { bytea } from './_custom';

// architecture.md §3 — executors (implemented as-is).
// PLATFORM-scoped since migration 0003 (2026-07-13): an executor is physical
// capacity (the CLI on the host, a subscription/API key) shared by the whole
// platform — the run.<type> queue and the worker's summed concurrency were
// already global, so the former workspace_id column lied about the scope.
export const executors = pgTable(
  'executors',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull().default({}),
    secrets: bytea('secrets'),
    concurrencyLimit: integer('concurrency_limit').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique('executors_name').on(t.name)],
);

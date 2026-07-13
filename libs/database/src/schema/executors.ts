import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, integer, boolean, unique } from 'drizzle-orm/pg-core';
import { bytea } from './_custom';

// architecture.md §3 — executors (implemented as-is).
// PLATFORM-scoped since migration 0003 (2026-07-13): an executor is a named
// runtime PROFILE — transport type (code registry; rows cannot create
// behavior) + model + turn/parallelism limits + optional credentials — shared
// by the whole platform. The run.<type> queue and the worker's summed
// concurrency were already global, so the former workspace_id column lied
// about the scope. `secrets` holds the profile's optional API key (AES-256-GCM
// envelope, same codec as workspace Jira credentials); `max_parallel_runs` is
// enforced per profile by the worker's processor-side gate.
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
    maxParallelRuns: integer('max_parallel_runs').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique('executors_name').on(t.name)],
);

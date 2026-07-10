import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, integer, boolean, unique } from 'drizzle-orm/pg-core';
import { bytea } from './_custom';
import { workspaces } from './workspaces';

// architecture.md §3 — executors (implemented as-is)
export const executors = pgTable(
  'executors',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull().default({}),
    secrets: bytea('secrets'),
    concurrencyLimit: integer('concurrency_limit').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique('executors_workspace_name').on(t.workspaceId, t.name)],
);

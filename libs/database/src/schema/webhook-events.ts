import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

// architecture.md §3 — webhook_events (ingest idempotency ledger).
// Table created now; populated from iteration 2 (no webhook path yet).
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    externalId: text('external_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('webhook_events_workspace_external').on(t.workspaceId, t.externalId)],
);

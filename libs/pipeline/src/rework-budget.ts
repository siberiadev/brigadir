import { and, eq, sql } from 'drizzle-orm';
import { type BrigadirDb, schema, getReworkMax } from '@brigadir/database';

export interface ReworkBudget {
  /** Number of `source='rework'` runs already on the ticket (derived, FR-006/D3). */
  cycleCount: number;
  /** The workspace's configured maximum (default 2). */
  max: number;
  /** `cycleCount < max` — whether another rework cycle is permitted. */
  available: boolean;
}

/**
 * Rework-cycle budget for a ticket (feature 010, FR-006/D3). The cycle count is
 * DERIVED from run history — the number of runs on the ticket whose
 * `trigger_event.source === 'rework'` — never a stored counter (Constitution I).
 * The per-workspace maximum lives in `workspaces.settings.rework_max` (default 2).
 *
 * Evaluated deterministically in pipeline code; the model is never trusted to
 * enforce it.
 */
export async function getReworkBudget(
  db: BrigadirDb,
  ticketId: string,
  workspaceId: string,
): Promise<ReworkBudget> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.ticketId, ticketId),
        sql`${schema.runs.triggerEvent} ->> 'source' = 'rework'`,
      ),
    );
  const cycleCount = row?.count ?? 0;
  const max = await getReworkMax(db, workspaceId);
  return { cycleCount, max, available: cycleCount < max };
}

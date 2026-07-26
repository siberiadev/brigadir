import { and, eq, isNull } from 'drizzle-orm';
import type { BrigadirDb } from './drizzle.constants';
import * as schema from './schema';

/**
 * Feature 032: create a run-less ticket task deduped on its exact TITLE.
 *
 * Lives here rather than in `HumanTaskService` because BOTH the service (for
 * the pipeline side) and the claude-cli executor (which raises the
 * inheritance diagnostics mid-prepare, where the run is still proceeding and
 * there is nothing to throw) must use the SAME dedup predicate. `libs/executors`
 * already depends on `@brigadir/database`, so sharing it here adds no package
 * edge and — more importantly — leaves exactly one implementation of the guard.
 *
 * Dedup key: open + run-less + same ticket + identical title. The title carries
 * the whole tuple (kind, blocker, repository) by construction, so a dependent
 * may hold several distinct notices at once while a repeated run adds none.
 * A RESOLVED task does not suppress a new one: if the condition still holds, it
 * genuinely still needs attention.
 */
export async function createKeyedTicketTask(
  db: Pick<BrigadirDb, 'select' | 'insert'>,
  input: { workspaceId: string; ticketId: string; title: string; details?: string },
): Promise<{ created: boolean }> {
  const existingOpen = await db
    .select({ id: schema.humanTasks.id })
    .from(schema.humanTasks)
    .where(
      and(
        eq(schema.humanTasks.ticketId, input.ticketId),
        isNull(schema.humanTasks.runId),
        eq(schema.humanTasks.status, 'open'),
        eq(schema.humanTasks.title, input.title),
      ),
    )
    .limit(1);
  if (existingOpen.length > 0) return { created: false };

  await db.insert(schema.humanTasks).values({
    workspaceId: input.workspaceId,
    runId: null,
    ticketId: input.ticketId,
    // `kind` stays 'blocker': HumanTaskKind is an agent-facing contract enum,
    // and the feature-032 taxonomy is internal (plan.md Complexity Tracking).
    kind: 'blocker',
    title: input.title,
    details: input.details ?? null,
    blocking: false,
    status: 'open',
  });
  return { created: true };
}

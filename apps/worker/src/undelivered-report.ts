import { and, eq } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';
import type { AgentReport } from '@brigadir/contracts';

/** run_events.type value for a rescued-but-not-applied report (feature 026, contracts/run-event-types.md). */
export const UNDELIVERED_REPORT_EVENT = 'undelivered_report';

export type UndeliveredReportSource = 'exit_reconcile' | 'periodic_reconcile';

/** Run statuses whose report we attach without ever flipping the status (intentional stops). */
export type UndeliveredReportRunStatus = 'cancelled' | 'superseded';

/**
 * Attach a schema-valid, ALREADY-scrubbed report to a run whose status must
 * not change (feature 026, US1/US3; Clarification Q2). Writes one
 * `undelivered_report` run-event so the verdict is visible to the operator on
 * the run timeline instead of being silently discarded with the outbox file.
 *
 * Idempotent: a pre-insert existence check means the exit-time reconcile and
 * the periodic reconciler cannot double-attach for the same run (no DB
 * constraint needed — run_events has no natural unique key here). Returns
 * whether a new event row was written.
 */
export async function attachUndeliveredReport(
  db: BrigadirDb,
  runId: string,
  report: AgentReport,
  runStatus: UndeliveredReportRunStatus,
  source: UndeliveredReportSource,
): Promise<boolean> {
  const existing = await db
    .select({ id: schema.runEvents.id })
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, UNDELIVERED_REPORT_EVENT)))
    .limit(1);
  if (existing.length > 0) return false;

  await db.insert(schema.runEvents).values({
    runId,
    type: UNDELIVERED_REPORT_EVENT,
    payload: { report, run_status: runStatus, source },
  });
  return true;
}

import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { PipelineService } from '@brigadir/pipeline';
import type { WorkspaceContext } from './poller.service';

/** Terminal run statuses that owe a Jira write (transition + comment). */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'timed_out', 'awaiting_human'];

/**
 * Drift repair (contracts.md C7 step 4 / research D8). Runs are NON-idempotent
 * and are never re-driven here. The only thing repaired is a PENDING JIRA WRITE:
 * a terminal run whose result is persisted (FR-022) but that lacks the
 * `run_events(type='jira_action')` marker — i.e. a crash landed between persist
 * and the Jira write. Re-applying is idempotent (transition no-ops when already
 * in target, FR-023) and routes through the per-issue write queue (Principle III).
 *
 * The complementary failure — a run stuck `running` because its job/process
 * vanished — is handled by the WatchdogService (timeout + grace → `timed_out`
 * + failure treatment), so this step is purely the persisted-but-unwritten case.
 *
 * Per-run isolation (SXF-1174 Problem 4): each repair is wrapped in its own
 * try/catch — one poisoned run (Jira 5xx, credential fault) must never starve
 * the rest of the pending set; it is logged and retried next pass. Pending runs
 * are processed oldest-first (deterministic ORDER BY).
 */
@Injectable()
export class DriftRepairService {
  private readonly logger = new Logger(DriftRepairService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly pipeline: PipelineService,
  ) {}

  async repair(ws: WorkspaceContext): Promise<void> {
    const pending = await this.db
      .select({ runId: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.workspaceId, ws.id),
          inArray(schema.runs.status, TERMINAL_STATUSES),
          sql`not exists (
            select 1 from ${schema.runEvents}
            where ${schema.runEvents.runId} = ${schema.runs.id}
              and ${schema.runEvents.type} = 'jira_action'
          )`,
        ),
      )
      .orderBy(asc(schema.runs.createdAt));

    for (const p of pending) {
      this.logger.warn(`drift repair: run ${p.runId} is terminal with no jira_action marker — re-applying Jira write`);
      try {
        await this.pipeline.onRunFinished(p.runId);
      } catch (err) {
        // Per-run isolation (SXF-1174 Problem 4): one poisoned run must not
        // starve the rest of the pending set. Logged and retried next pass.
        this.logger.error(
          `drift repair: run ${p.runId} failed (others continue, retried next pass): ${String(err)}`,
        );
      }
    }
  }
}

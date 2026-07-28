import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { RunsService } from '@brigadir/runs';
import { PipelineService } from '@brigadir/pipeline';
import type { WorkspaceContext } from './poller.service';

/** Extra minutes past `timeout_minutes` before the watchdog force-finalizes. */
const DEFAULT_GRACE_MINUTES = 5;

/**
 * Watchdog (contracts.md C7 step 3 / FR-015). A run still `running` past
 * `agent.timeout_minutes + grace` is finalized `timed_out` and given the
 * failure-outcome Jira treatment via `onRunFinished` (persist-then-write). This
 * guarantees "no run hangs forever" (NFR-1) even if a worker/process vanished
 * without reporting.
 */
@Injectable()
export class WatchdogService {
  private readonly logger = new Logger(WatchdogService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runs: RunsService,
    private readonly pipeline: PipelineService,
  ) {}

  async sweep(ws: WorkspaceContext): Promise<void> {
    const grace = Number(process.env.WATCHDOG_GRACE_MINUTES ?? DEFAULT_GRACE_MINUTES);

    const stale = await this.db
      .select({ runId: schema.runs.id, timeoutMinutes: schema.agents.timeoutMinutes })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(
        and(
          eq(schema.runs.workspaceId, ws.id),
          eq(schema.runs.status, 'running'),
          sql`${schema.runs.startedAt} < now() - ((${schema.agents.timeoutMinutes} + ${grace}) * interval '1 minute')`,
        ),
      )
      .orderBy(asc(schema.runs.startedAt));

    for (const s of stale) {
      try {
        const finalized = await this.runs.finalizeStatus(s.runId, 'timed_out', {
          error: `watchdog: exceeded timeout (${s.timeoutMinutes}m) + grace (${grace}m)`,
        });
        if (finalized) {
          this.logger.warn(`watchdog finalized run ${s.runId} as timed_out`);
          await this.pipeline.onRunFinished(s.runId);
        }
      } catch (err) {
        // Per-run isolation (SXF-1174 Problem 4): the run is already finalized
        // timed_out (guarded DB write) — only its Jira write is pending, and
        // drift repair picks that up (terminal, no marker). Later stale runs
        // must still be finalized NOW, not next pass.
        this.logger.error(
          `watchdog: run ${s.runId} completion failed (others continue; Jira write repaired next pass): ${String(err)}`,
        );
      }
    }
  }
}

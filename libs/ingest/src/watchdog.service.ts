import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { RunsService } from '@brigadir/runs';
import { PipelineService } from '@brigadir/pipeline';
import type { WorkspaceContext } from './poller.service';

/** Extra minutes past `timeout_minutes` before the watchdog force-finalizes. */
const DEFAULT_GRACE_MINUTES = 5;

/**
 * Minutes a run may sit `queued` before the watchdog declares its job lost and
 * finalizes it `failed`. Deliberately far above the running-run budget: a
 * queued run legitimately lives for hours through rate-limit re-parks (the 5h
 * subscription window re-queues without consuming attempts), so
 * `timeout_minutes` is the wrong yardstick here.
 */
const DEFAULT_QUEUED_SWEEP_MINUTES = 720;

/**
 * Parse a minutes-valued env setting. A malformed value falls back to the
 * default and is flagged (`malformed: true`) so the caller can warn — never a
 * silent no-op: `Number('abc')` is NaN, and NaN interpolated into the sweep's
 * SQL interval makes the predicate NULL, silently selecting zero rows forever
 * (the exact failure mode the watchdog exists to prevent). Failing hard would
 * be worse still — a typo'd env var must not disable run reaping.
 */
export function resolveMinutesSetting(
  raw: string | undefined,
  fallback: number,
): { minutes: number; malformed: boolean } {
  if (raw === undefined) return { minutes: fallback, malformed: false };
  const trimmed = raw.trim();
  // Number('') === 0 — an accidentally empty env var must not become a zero
  // grace/threshold; only an explicit number counts.
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return { minutes: fallback, malformed: true };
  return { minutes: parsed, malformed: false };
}

/**
 * Watchdog (contracts.md C7 / FR-015). Guarantees "no run hangs forever"
 * (NFR-1) even if a worker/process vanished without reporting:
 *  - a run still `running` past `agent.timeout_minutes + grace` is finalized
 *    `timed_out`;
 *  - a run still `queued` past `WATCHDOG_QUEUED_SWEEP_MINUTES` (job consumed
 *    and dropped, or never enqueued) is finalized `failed` — nothing ever
 *    started, so `timed_out` would lie;
 * each with the failure-outcome Jira treatment via `onRunFinished`
 * (persist-then-write) for ENABLED workspaces only.
 *
 * Feature 034: the sweep is a pure-DB operation and runs Jira-free across ALL
 * workspaces (`sweepAll`), including disabled ones — a disabled workspace's
 * zombie run would otherwise hold the `runs_one_active` slot forever. For
 * disabled workspaces only the DB flip + run_event happen (FR-028: disabled ⇒
 * no Jira work); DriftRepairService heals the missing Jira write after
 * re-enable (terminal status, no `jira_action` marker).
 */
@Injectable()
export class WatchdogService {
  private readonly logger = new Logger(WatchdogService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runs: RunsService,
    private readonly pipeline: PipelineService,
  ) {}

  /** Global sweep, no Jira prerequisites — reconcile calls this BEFORE any per-workspace Jira work. */
  async sweepAll(): Promise<void> {
    await this.sweepScoped(undefined);
  }

  /** Workspace-scoped sweep, retained as the seam for workspace-level tests. */
  async sweep(ws: WorkspaceContext): Promise<void> {
    await this.sweepScoped(ws.id);
  }

  private async sweepScoped(workspaceId: string | undefined): Promise<void> {
    const grace = this.resolveSetting('WATCHDOG_GRACE_MINUTES', DEFAULT_GRACE_MINUTES);
    const queuedAfter = this.resolveSetting(
      'WATCHDOG_QUEUED_SWEEP_MINUTES',
      DEFAULT_QUEUED_SWEEP_MINUTES,
    );
    const enabled = await this.enabledWorkspaceIds();

    const staleRunning = await this.db
      .select({
        runId: schema.runs.id,
        workspaceId: schema.runs.workspaceId,
        timeoutMinutes: schema.agents.timeoutMinutes,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(
        and(
          workspaceId ? eq(schema.runs.workspaceId, workspaceId) : undefined,
          eq(schema.runs.status, 'running'),
          sql`${schema.runs.startedAt} < now() - ((${schema.agents.timeoutMinutes} + ${grace}) * interval '1 minute')`,
        ),
      )
      .orderBy(asc(schema.runs.startedAt));

    for (const s of staleRunning) {
      await this.finalizeStale(s.runId, enabled.has(s.workspaceId), {
        status: 'timed_out',
        error: `watchdog: exceeded timeout (${s.timeoutMinutes}m) + grace (${grace}m)`,
        message: `watchdog: run exceeded timeout (${s.timeoutMinutes}m) + grace (${grace}m) — force-finalized as timed_out`,
      });
    }

    // Ticketless setup runs also occupy no active slot per ticket, but stale
    // queued rows of any kind block `runs_one_active` and leak forever — a job
    // consumed-and-dropped (or never enqueued) leaves nothing else to reap them.
    const staleQueued = await this.db
      .select({ runId: schema.runs.id, workspaceId: schema.runs.workspaceId })
      .from(schema.runs)
      .where(
        and(
          workspaceId ? eq(schema.runs.workspaceId, workspaceId) : undefined,
          eq(schema.runs.status, 'queued'),
          isNull(schema.runs.startedAt),
          sql`${schema.runs.createdAt} < now() - (${queuedAfter} * interval '1 minute')`,
        ),
      )
      .orderBy(asc(schema.runs.createdAt));

    for (const s of staleQueued) {
      await this.finalizeStale(s.runId, enabled.has(s.workspaceId), {
        status: 'failed',
        error: `watchdog: stuck in queued for over ${queuedAfter}m (job lost or never consumed)`,
        message: `watchdog: run stuck in queued for over ${queuedAfter}m (job lost or never consumed) — finalized as failed`,
      });
    }
  }

  private async finalizeStale(
    runId: string,
    workspaceEnabled: boolean,
    outcome: { status: 'timed_out' | 'failed'; error: string; message: string },
  ): Promise<void> {
    try {
      const finalized = await this.runs.finalizeStatus(runId, outcome.status, {
        error: outcome.error,
      });
      if (!finalized) return;
      this.logger.warn(`watchdog finalized run ${runId} as ${outcome.status}`);
      // Best-effort timeline event (precedent: `start-ref`) — renders with
      // zero web changes; never blocks the sweep.
      await this.db
        .insert(schema.runEvents)
        .values({ runId, type: 'log', payload: { source: 'watchdog', message: outcome.message } })
        .catch((err: unknown) =>
          this.logger.error(`watchdog: run_event insert failed for ${runId}: ${String(err)}`),
        );
      // FR-028: a disabled workspace gets no Jira work; drift repair applies
      // the transition/comment after re-enable (terminal, no marker).
      if (workspaceEnabled) await this.pipeline.onRunFinished(runId);
    } catch (err) {
      // Per-run isolation (SXF-1174 Problem 4): the run is already finalized
      // (guarded DB write) — only its Jira write is pending, and drift repair
      // picks that up (terminal, no marker). Later stale runs must still be
      // finalized NOW, not next pass.
      this.logger.error(
        `watchdog: run ${runId} completion failed (others continue; Jira write repaired next pass): ${String(err)}`,
      );
    }
  }

  private resolveSetting(envVar: string, fallback: number): number {
    const { minutes, malformed } = resolveMinutesSetting(process.env[envVar], fallback);
    if (malformed) {
      this.logger.warn(
        `watchdog: malformed ${envVar}=${JSON.stringify(process.env[envVar])} — falling back to ${fallback}m`,
      );
    }
    return minutes;
  }

  private async enabledWorkspaceIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.settings}->>'enabled' is distinct from 'false'`);
    return new Set(rows.map((r) => r.id));
  }
}

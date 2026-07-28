import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { ReportSchema, type AgentReport } from '@brigadir/contracts';
import type { TerminalStatus } from './status-mapping';

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_human'];
/** Terminal-bad statuses a durable-outbox report may still rescue (feature 026, US3). */
const RESCUABLE_TERMINAL_STATUSES = ['failed', 'timed_out'];

export interface FinalizeExtra {
  externalRef?: string;
  costUsd?: number;
  usage?: unknown;
  error?: string;
  exitCode?: number;
}

/**
 * Report outcome → terminal run status. `routed` is a terminal SUCCESS of the
 * orchestrator's triage turn (feature 010): the run did its job and produced a
 * decision; the pipeline's orchestrator-completion branch then acts on it.
 * Only `needs_human` parks.
 */
function reportTerminalStatus(report: AgentReport): TerminalStatus {
  return report.outcome === 'success' || report.outcome === 'routed'
    ? 'succeeded'
    : report.outcome === 'failure'
      ? 'failed'
      : 'awaiting_human';
}

/**
 * RunsService — the run state machine (data-model.md invariants).
 *
 * Every terminal write is a guarded UPDATE (`WHERE status IN (active)`); a second
 * finalize affects 0 rows and is logged, not applied (terminal immutability).
 * `awaiting_human` creates exactly one open `human_tasks` row (deduped per run).
 * Reports are validated against `ReportSchema` before persistence (Constitution
 * IV gate).
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  /**
   * Enter `running`: stamp `started_at` once, set the current attempt number.
   * `attempt` here is the BullMQ-level retry count for THIS row
   * (`job.attemptsMade + 1`) — GREATEST-guarded (not a blind overwrite) so it
   * never regresses a resume-seeded row's own attempt number (feature 004:
   * ResumeService inserts the new attempt's row with `attempt = parked + 1`
   * BEFORE the job's first processing ever calls this with
   * `job.attemptsMade=0` → local attempt `1`, which must not clobber it).
   */
  async markRunning(runId: string, attempt: number): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      .set({
        status: 'running',
        startedAt: sql`coalesce(started_at, now())`,
        attempt: sql`GREATEST(${schema.runs.attempt}, ${attempt})`,
      })
      .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, ['queued', 'running'])))
      .returning({ id: schema.runs.id });
    return rows.length > 0;
  }

  /** Return an active run to `queued` between crash retries (keeps it active). */
  async markQueuedForRetry(runId: string): Promise<void> {
    await this.db
      .update(schema.runs)
      .set({ status: 'queued' })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')));
  }

  /**
   * Finalize a `completed` run from its structured report. Validates against
   * ReportSchema, guarded-finalizes to succeeded|failed|awaiting_human, writes
   * run_checks, and creates the human_task for needs_human.
   */
  async finalizeWithReport(
    runId: string,
    rawReport: unknown,
    extra: FinalizeExtra = {},
  ): Promise<boolean> {
    const report = ReportSchema.parse(rawReport);
    const status = reportTerminalStatus(report);

    const finalized = await this.guardedFinalize(runId, status, {
      outcome: report.outcome,
      report,
      ...extra,
    });
    if (!finalized) {
      this.logger.warn(`finalizeWithReport skipped — run ${runId} not active`);
      return false;
    }

    await this.applyReportEffects(runId, report);
    return true;
  }

  /**
   * Reconcile a run from a durable outbox report during the periodic sweep
   * (feature 026, US3). Widens `finalizeWithReport`'s guard to ALSO rescue a
   * run whose PROCESS outcome finalized it WITHOUT a report outcome
   * (`failed`/`timed_out`, `outcome IS NULL`) — e.g. an exit-time fail-close
   * that raced the outbox, or a worker death that left the run mid-flight and
   * a later watchdog stamped it `timed_out`. Still ONE atomic guarded UPDATE
   * (race-safe, returns the flipped flag; a live callback that already applied
   * an outcome makes this a 0-row no-op), and writes run_checks / the
   * needs_human task on flip exactly like the live path.
   */
  async reconcileWithReport(
    runId: string,
    rawReport: unknown,
    extra: FinalizeExtra = {},
  ): Promise<boolean> {
    const report = ReportSchema.parse(rawReport);
    const status = reportTerminalStatus(report);

    const rows = await this.db
      .update(schema.runs)
      .set({ status, finishedAt: sql`now()`, outcome: report.outcome, report, ...(extra as Record<string, never>) })
      .where(
        and(
          eq(schema.runs.id, runId),
          or(
            inArray(schema.runs.status, ACTIVE_STATUSES),
            and(inArray(schema.runs.status, RESCUABLE_TERMINAL_STATUSES), isNull(schema.runs.outcome)),
          ),
        ),
      )
      .returning({ id: schema.runs.id });
    if (rows.length === 0) {
      this.logger.log(`reconcileWithReport: run ${runId} no-op (already finalized with an outcome)`);
      return false;
    }

    await this.applyReportEffects(runId, report);
    return true;
  }

  private async applyReportEffects(runId: string, report: AgentReport): Promise<void> {
    await this.writeChecks(runId, report);
    if (report.outcome === 'needs_human' && report.human_task) {
      await this.createHumanTask(runId, report.human_task);
    }
  }

  /**
   * Fail-closed guard for callback-wired runs (D7, FR-010/011). Guards
   * `WHERE status = 'running'` ONLY — deliberately narrower than
   * `guardedFinalize`'s full active set — so a run legitimately parked
   * `awaiting_human` (blocking `request_human`) or already finalized is a
   * 0-row no-op, never clobbered by a silent process exit.
   */
  async failIfStillRunning(runId: string, diagnostic: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      .set({ status: 'failed', finishedAt: sql`now()`, error: diagnostic })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
      .returning({ id: schema.runs.id });
    const flipped = rows.length > 0;
    if (!flipped) {
      this.logger.log(`failIfStillRunning: run ${runId} no-op (not 'running' — awaiting_human or already finalized)`);
    }
    return flipped;
  }

  /**
   * SXF-1174 Problem 7 (defense-in-depth): promotion counterpart of the
   * fail-closed guard. When the process exits while an open BLOCKING human
   * task exists but the park was somehow missed, the run is parked
   * `awaiting_human` instead of fail-closed — the pending human question
   * survives. Same guard discipline: `WHERE status = 'running'` ONLY.
   */
  async parkIfStillRunning(runId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      .set({ status: 'awaiting_human' })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
      .returning({ id: schema.runs.id });
    return rows.length > 0;
  }

  /**
   * Process-exit-derived finalize for callback-wired runs — the D7 posture of
   * `failIfStillRunning`, generalized to any terminal status (timed_out,
   * cancelled, crash-exhausted). Guards `WHERE status = 'running'` ONLY: the
   * process outcome may finalize a run only while the callbacks haven't
   * already parked it (`awaiting_human`) or finalized it. Found the hard way:
   * the cancel-poll sees a legitimately parked run as "no longer running",
   * aborts the lingering process, and without this guard the resulting
   * 'cancelled'/'timed_out' finalize would clobber the park.
   */
  async finalizeStatusIfRunning(
    runId: string,
    status: TerminalStatus,
    extra: FinalizeExtra = {},
  ): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      // Same loose-fields spread as guardedFinalize (FinalizeExtra's number
      // costUsd serializes fine into the numeric column at runtime).
      .set({ status, finishedAt: sql`now()`, ...(extra as Record<string, never>) })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
      .returning({ id: schema.runs.id });
    const flipped = rows.length > 0;
    if (!flipped) {
      this.logger.log(
        `finalizeStatusIfRunning(${status}): run ${runId} no-op (not 'running' — parked or already finalized)`,
      );
    }
    return flipped;
  }

  /**
   * Status-independent cost/usage write. Callback-wired runs are finalized by
   * the complete_task callback BEFORE the CLI process exits, so the terminal
   * stream event's total_cost_usd/usage only become known post-exit — when
   * every status-writing path is (correctly, CLAUDE.md rule #7) a
   * `WHERE status='running'` no-op. cost_usd/usage are data columns, not
   * state: writing them by id clobbers nothing the callbacks own. Overwrite
   * semantics: the last CLI session that emitted a result event wins (a
   * retried attempt's terminal replaces a rate-limited attempt's partial
   * cost). Best-effort — NEVER throws: this call sits between the executor
   * settling and finalize, and a throw there would fail the job and re-run a
   * non-idempotent agent via BullMQ retry (rule #2).
   */
  async recordCostUsage(
    runId: string,
    values: { costUsd?: number; usage?: unknown },
  ): Promise<void> {
    const set: { costUsd?: string; usage?: unknown } = {};
    // Drizzle numeric columns carry strings; convert explicitly here (the
    // finalize paths rely on runtime coercion instead — see guardedFinalize).
    if (values.costUsd !== undefined) set.costUsd = String(values.costUsd);
    if (values.usage !== undefined) set.usage = values.usage;
    if (Object.keys(set).length === 0) return;
    try {
      await this.db.update(schema.runs).set(set).where(eq(schema.runs.id, runId));
    } catch (err) {
      this.logger.error(`recordCostUsage failed for run ${runId}: ${String(err)}`);
    }
  }

  /** Finalize to a terminal status without a report (timeout, crash-exhausted, cancelled). */
  async finalizeStatus(
    runId: string,
    status: TerminalStatus,
    extra: FinalizeExtra = {},
  ): Promise<boolean> {
    const finalized = await this.guardedFinalize(runId, status, { ...extra });
    if (!finalized) {
      this.logger.warn(`finalizeStatus(${status}) skipped — run ${runId} not active`);
    }
    return finalized;
  }

  private async guardedFinalize(
    runId: string,
    status: TerminalStatus,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      .set({ status, finishedAt: sql`now()`, ...fields })
      .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, ACTIVE_STATUSES)))
      .returning({ id: schema.runs.id });
    return rows.length > 0;
  }

  private async writeChecks(runId: string, report: AgentReport): Promise<void> {
    if (!report.checks.length) return;
    await this.db.insert(schema.runChecks).values(
      report.checks.map((check, position) => ({
        runId,
        position,
        name: check.name,
        status: check.status,
        reason: check.reason ?? null,
      })),
    );
  }

  private async createHumanTask(
    runId: string,
    humanTask: NonNullable<AgentReport['human_task']>,
  ): Promise<void> {
    // dedup: one open BLOCKING human_task per run (this path always inserts
    // blocking=true). Per-blocking-ness, matching HumanTaskService (SXF-1174
    // Problem 7): an open non-blocking FYI must not swallow the blocking
    // question a needs_human report carries.
    const existing = await this.db
      .select({ id: schema.humanTasks.id })
      .from(schema.humanTasks)
      .where(
        and(
          eq(schema.humanTasks.runId, runId),
          eq(schema.humanTasks.status, 'open'),
          eq(schema.humanTasks.blocking, true),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    const [run] = await this.db
      .select({ workspaceId: schema.runs.workspaceId, ticketId: schema.runs.ticketId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) return;

    await this.db.insert(schema.humanTasks).values({
      workspaceId: run.workspaceId,
      runId,
      ticketId: run.ticketId,
      kind: humanTask.kind,
      title: humanTask.title,
      details: humanTask.details ?? null,
      // feature 013: options arrive pre-scrubbed (CallbackService.scrubReport).
      options: humanTask.options ?? null,
      blocking: true,
      status: 'open',
    });
  }
}

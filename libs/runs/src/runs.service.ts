import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { ReportSchema, type AgentReport } from '@brigadir/contracts';
import type { TerminalStatus } from './status-mapping';

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_human'];

export interface FinalizeExtra {
  externalRef?: string;
  costUsd?: number;
  usage?: unknown;
  error?: string;
  exitCode?: number;
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

  /** Enter `running`: stamp `started_at` once, set the current attempt number. */
  async markRunning(runId: string, attempt: number): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      .set({ status: 'running', startedAt: sql`coalesce(started_at, now())`, attempt })
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
    const status: TerminalStatus =
      report.outcome === 'success'
        ? 'succeeded'
        : report.outcome === 'failure'
          ? 'failed'
          : 'awaiting_human';

    const finalized = await this.guardedFinalize(runId, status, {
      outcome: report.outcome,
      report,
      ...extra,
    });
    if (!finalized) {
      this.logger.warn(`finalizeWithReport skipped — run ${runId} not active`);
      return false;
    }

    await this.writeChecks(runId, report);
    if (report.outcome === 'needs_human' && report.human_task) {
      await this.createHumanTask(runId, report.human_task);
    }
    return true;
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
    // dedup: one open human_task per run
    const existing = await this.db
      .select({ id: schema.humanTasks.id })
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, runId), eq(schema.humanTasks.status, 'open')))
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
      blocking: true,
      status: 'open',
    });
  }
}

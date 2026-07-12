import { Injectable, Inject, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { runQueueName } from '@brigadir/queues';
import {
  ReportSchema,
  ReportProgressSchema,
  RequestHumanSchema,
  type AgentReport,
} from '@brigadir/contracts';
import { scrub } from '@brigadir/scrubber';
import { RunsService } from '@brigadir/runs';
import { PipelineService } from '@brigadir/pipeline';
import { HumanTaskService } from '@brigadir/human-tasks';

export interface ValidationFailure {
  kind: 'validation';
  errors: unknown[];
}

export interface ConflictFailure {
  kind: 'conflict';
}

function scrubReport(report: AgentReport): AgentReport {
  return {
    ...report,
    summary: scrub(report.summary),
    checks: report.checks.map((check) => ({
      ...check,
      reason: check.reason !== undefined ? scrub(check.reason) : check.reason,
    })),
    human_task: report.human_task
      ? {
          ...report.human_task,
          title: scrub(report.human_task.title),
          details: report.human_task.details !== undefined ? scrub(report.human_task.details) : report.human_task.details,
        }
      : report.human_task,
  };
}

/**
 * CallbackService (contracts/callback-http-api.md). Validates each callback
 * against its zod schema (422 on failure, run untouched), scrubs free text
 * BEFORE persistence (covers the downstream Jira write too, since
 * PipelineService builds its ADF comment from the stored — already scrubbed
 * — report), and delegates completion/human-task effects to RunsService /
 * PipelineService / HumanTaskService.
 */
@Injectable()
export class CallbackService {
  private readonly logger = new Logger(CallbackService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly moduleRef: ModuleRef,
    private readonly runs: RunsService,
    private readonly pipeline: PipelineService,
    private readonly humanTasks: HumanTaskService,
  ) {}

  async progress(runId: string, rawBody: unknown): Promise<{ ok: true } | ValidationFailure> {
    const parsed = ReportProgressSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { kind: 'validation', errors: parsed.error.issues };
    }
    const input = parsed.data;
    const scrubbedMessage = scrub(input.message);

    await this.db.insert(schema.runEvents).values({
      runId,
      type: 'progress',
      payload: { stage: input.stage, message: scrubbedMessage, percent: input.percent },
    });

    await this.updateJobProgressBestEffort(runId, { stage: input.stage, percent: input.percent });

    return { ok: true };
  }

  async human(
    runId: string,
    rawBody: unknown,
  ): Promise<{ ok: true; blocking: boolean; mayFinishWithoutComplete?: boolean } | ValidationFailure> {
    const parsed = RequestHumanSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { kind: 'validation', errors: parsed.error.issues };
    }
    const input = parsed.data;

    const result = await this.humanTasks.createFromRequest(runId, {
      kind: input.kind,
      title: scrub(input.title),
      details: scrub(input.details),
      blocking: input.blocking,
    });

    return result.blocking
      ? { ok: true, blocking: true, mayFinishWithoutComplete: result.mayFinishWithoutComplete }
      : { ok: true, blocking: false };
  }

  async complete(
    runId: string,
    rawBody: unknown,
  ): Promise<{ ok: true; outcome: AgentReport['outcome'] } | ValidationFailure | ConflictFailure> {
    const parsed = ReportSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { kind: 'validation', errors: parsed.error.issues };
    }

    const scrubbedReport = scrubReport(parsed.data);

    const finalized = await this.runs.finalizeWithReport(runId, scrubbedReport);
    if (!finalized) {
      return { kind: 'conflict' };
    }

    await this.maybeQueueReviewTask(runId, scrubbedReport);

    try {
      await this.pipeline.onRunFinished(runId);
    } catch (err) {
      this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
    }

    return { ok: true, outcome: scrubbedReport.outcome };
  }

  /** FR-025: a successful pull_request-delivery run with a declared PR queues one non-blocking review task. */
  private async maybeQueueReviewTask(runId: string, report: AgentReport): Promise<void> {
    if (report.outcome !== 'success' || !report.artifacts?.pr_url) return;

    const [row] = await this.db
      .select({ behavior: schema.agents.behavior })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    const behavior = (row?.behavior ?? {}) as { code_delivery?: string };
    if (behavior.code_delivery !== 'pull_request') return;

    await this.humanTasks.createFromRequest(runId, {
      kind: 'review',
      title: `Review PR: ${report.artifacts.pr_url}`,
      details: report.artifacts.pr_url,
      blocking: false,
    });
  }

  /**
   * Best-effort BullMQ job.updateProgress() (callback-http-api.md). Never
   * fatal — run_events is the tested source of truth for the timeline
   * (SC-006); this is supplementary dashboard-progress-bar plumbing. The job
   * is resolved by its id, which RunTriggerService pins to the run id.
   */
  private async updateJobProgressBestEffort(
    runId: string,
    progress: { stage: string; percent?: number },
  ): Promise<void> {
    try {
      const [row] = await this.db
        .select({ executorType: schema.runs.executorType })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      if (!row) return;

      const queue = this.moduleRef.get<Queue>(getQueueToken(runQueueName(row.executorType)), {
        strict: false,
      });
      const job = await queue.getJob(runId);
      await job?.updateProgress(progress);
    } catch (err) {
      this.logger.warn(`job.updateProgress best-effort failed for run ${runId}: ${String(err)}`);
    }
  }
}

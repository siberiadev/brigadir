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
  normalizeReportArtifacts,
  type AgentReport,
  type AnswerOption,
} from '@brigadir/contracts';
import { scrub } from '@brigadir/scrubber';
import { RunsService } from '@brigadir/runs';
import { PipelineService, SetupApplyService } from '@brigadir/pipeline';
import { HumanTaskService } from '@brigadir/human-tasks';

export interface ValidationFailure {
  kind: 'validation';
  errors: unknown[];
}

export interface ConflictFailure {
  kind: 'conflict';
}

// feature 013 (Constitution V): option texts are free text and reach
// persistence + the Jira question comment, so every field is scrubbed —
// the same guarantee as title/details.
function scrubOptions(options: AnswerOption[] | undefined): AnswerOption[] | undefined {
  return options?.map((option) => ({
    ...option,
    label: scrub(option.label),
    value: option.value !== undefined ? scrub(option.value) : option.value,
    description: option.description !== undefined ? scrub(option.description) : option.description,
  }));
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
          options: scrubOptions(report.human_task.options),
        }
      : report.human_task,
    // feature 010 (FR-003, Constitution V): the routing task is free text and
    // reaches persistence + the Jira routing comment, so it is scrubbed like
    // every other report field. `target_agent` is a bounded agent name, not
    // free prose — left as-is (it is validated against the roster downstream).
    routing: report.routing
      ? { ...report.routing, task: scrub(report.routing.task) }
      : report.routing,
    // feature 011 (FR-018): proposal free text is scrubbed before persistence /
    // agent-row insert; identifiers (name, statuses, executor) are validated
    // against workspace state instead, mirroring `target_agent`.
    team: report.team
      ? {
          agents: report.team.agents.map((a) => ({
            ...a,
            description: scrub(a.description),
            instruction: scrub(a.instruction),
          })),
        }
      : report.team,
    // feature 019 (research D7, Constitution V): artifact strings are
    // agent-authored and reach persistence + the Jira comment + the dashboard
    // card, so BOTH forms are scrubbed — the flat legacy fields (previously
    // missed entirely) and every repos[] entry. files_changed is numeric.
    artifacts: report.artifacts
      ? {
          ...report.artifacts,
          branch: report.artifacts.branch !== undefined ? scrub(report.artifacts.branch) : undefined,
          pr_url: report.artifacts.pr_url !== undefined ? scrub(report.artifacts.pr_url) : undefined,
          commits: report.artifacts.commits?.map((c) => scrub(c)),
          repos: report.artifacts.repos?.map((r) => ({
            ...r,
            repo: scrub(r.repo),
            branch: r.branch !== undefined ? scrub(r.branch) : undefined,
            pr_url: r.pr_url !== undefined ? scrub(r.pr_url) : undefined,
            commits: r.commits?.map((c) => scrub(c)),
          })),
        }
      : report.artifacts,
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
    private readonly setupApply: SetupApplyService,
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
      options: scrubOptions(input.options),
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

    // feature 011 (D9/D10): a `team` report takes the setup accept path —
    // business validation + atomic apply (agents + review task + finalize) in
    // one transaction. Invalid ⇒ 422 with the issue list; the run stays active
    // so the agent can correct the proposal and call complete_task again.
    if (scrubbedReport.outcome === 'team') {
      const accepted = await this.setupApply.acceptTeamReport(runId, scrubbedReport);
      if (accepted.kind === 'invalid') return { kind: 'validation', errors: accepted.issues };
      if (accepted.kind === 'conflict') return { kind: 'conflict' };
      try {
        await this.pipeline.onRunFinished(runId);
      } catch (err) {
        this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
      }
      return { ok: true, outcome: accepted.kind === 'recast_failure' ? 'failure' : 'team' };
    }

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

  /**
   * FR-025: a successful pull_request-delivery run with declared PR(s) queues
   * ONE non-blocking review task per run (feature 019, research D6): a single
   * PR keeps the pre-019 title byte-for-byte; several PRs (multi-repo run)
   * become one task listing every `<repo>: <url>` — one run, one review gate.
   */
  private async maybeQueueReviewTask(runId: string, report: AgentReport): Promise<void> {
    if (report.outcome !== 'success') return;
    const prs = normalizeReportArtifacts(report)
      .filter((a) => a.pr_url)
      .map((a) => ({ repo: a.repo, pr_url: a.pr_url! }));
    if (prs.length === 0) return;

    const [row] = await this.db
      .select({ behavior: schema.agents.behavior })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    const behavior = (row?.behavior ?? {}) as { code_delivery?: string };
    if (behavior.code_delivery !== 'pull_request') return;

    const single = prs.length === 1;
    await this.humanTasks.createFromRequest(runId, {
      kind: 'review',
      title: single ? `Review PR: ${prs[0].pr_url}` : `Review PRs (${prs.length})`,
      details: single
        ? prs[0].pr_url
        : prs.map((p) => `- ${p.repo ? `${p.repo}: ` : ''}${p.pr_url}`).join('\n'),
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

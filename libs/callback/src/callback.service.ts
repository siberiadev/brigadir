import { Injectable, Inject, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { runQueueName } from '@brigadir/queues';
import {
  ReportSchema,
  ReportProgressSchema,
  RequestHumanSchema,
  normalizeReportArtifacts,
  buildVerificationReceipt,
  type AgentReport,
} from '@brigadir/contracts';
import { scrub } from '@brigadir/scrubber';
import { RunsService } from '@brigadir/runs';
import { PipelineService, SetupApplyService } from '@brigadir/pipeline';
import { HumanTaskService } from '@brigadir/human-tasks';
import { detectHandoffViolations, parseObservedHeads } from './completion-gate';
// feature 026 (research D10): scrubbing moved to one shared audit point so the
// worker reconcile paths persist reports through the exact same scrubber.
import { scrubAgentReport, scrubOptions } from './report-scrub';

export interface ValidationFailure {
  kind: 'validation';
  errors: unknown[];
}

export interface ConflictFailure {
  kind: 'conflict';
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
      // `via: 'callback'` (feature 027, additive): отличает progress, реально
      // ПОЛУЧЕННЫЙ backend'ом по HTTP, от executor-наблюдений того же вызова
      // из stream-parser'а (тот пишет 'progress' независимо от доставки).
      // Источник `last_successful_callback_at` в /api/channel-health.
      payload: { stage: input.stage, message: scrubbedMessage, percent: input.percent, via: 'callback' },
    });

    await this.updateJobProgressBestEffort(runId, { stage: input.stage, percent: input.percent });

    return { ok: true };
  }

  async human(
    runId: string,
    rawBody: unknown,
  ): Promise<
    { ok: true; created: boolean; blocking: boolean; mayFinishWithoutComplete?: boolean } | ValidationFailure
  > {
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

    // `created:false` = dedup no-op (an open task of the same blocking-ness
    // already exists). Surfaced so the agent can tell a real park from a
    // swallowed one (SXF-1174 Problem 7 — the two were byte-identical).
    return result.blocking
      ? { ok: true, created: result.created, blocking: true, mayFinishWithoutComplete: result.mayFinishWithoutComplete }
      : { ok: true, created: result.created, blocking: false };
  }

  async complete(
    runId: string,
    rawBody: unknown,
    observedHeadsHeader?: string,
  ): Promise<{ ok: true; outcome: AgentReport['outcome'] } | ValidationFailure | ConflictFailure> {
    const parsed = ReportSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { kind: 'validation', errors: parsed.error.issues };
    }

    const scrubbedReport = scrubAgentReport(parsed.data);

    // feature 024 (US3): before the run finalizes, reject a completion that
    // omits a repository whose worktree HEAD moved past its recorded start
    // commit. Evidence-absent cases (no header, no start-ref baseline) pass
    // through untouched. Applied to ALL outcomes: a rework/resume continuation
    // reads a `failure`/`needs_human` report too, so those must be honest.
    const gateFailure = await this.checkHandoffGate(runId, scrubbedReport, observedHeadsHeader);
    if (gateFailure) return gateFailure;

    // feature 011 (D9/D10): a `team` report takes the setup accept path —
    // business validation + atomic apply (agents + review task + finalize) in
    // one transaction. Invalid ⇒ 422 with the issue list; the run stays active
    // so the agent can correct the proposal and call complete_task again.
    if (scrubbedReport.outcome === 'team') {
      const accepted = await this.setupApply.acceptTeamReport(runId, scrubbedReport);
      if (accepted.kind === 'invalid') return { kind: 'validation', errors: accepted.issues };
      if (accepted.kind === 'conflict') return { kind: 'conflict' };
      Promise.resolve()
        .then(() => this.pipeline.onRunFinished(runId))
        .catch((err) => {
          this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
        });
      return { ok: true, outcome: accepted.kind === 'recast_failure' ? 'failure' : 'team' };
    }

    const finalized = await this.runs.finalizeWithReport(runId, scrubbedReport);
    if (!finalized) {
      return { kind: 'conflict' };
    }

    await this.writeVerificationReceiptBestEffort(runId, scrubbedReport, observedHeadsHeader);

    await this.maybeQueueReviewTask(runId, scrubbedReport);

    Promise.resolve()
      .then(() => this.pipeline.onRunFinished(runId))
      .catch((err) => {
        this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
      });

    return { ok: true, outcome: scrubbedReport.outcome };
  }

  /**
   * Completion gate (feature 024, US3; contracts/completion-gate.md). Returns
   * a validation failure — leaving the run ACTIVE, exactly like an invalid
   * team report — when the completion omits a repository whose worktree HEAD
   * moved past its recorded start commit. Degrades silently (returns
   * undefined, completion proceeds) whenever evidence is absent: no observed-
   * heads header, no start-ref baseline for this run (no-repo triage,
   * workspace-setup, Phase-0 runs), or a repo the header did not observe.
   */
  private async checkHandoffGate(
    runId: string,
    report: AgentReport,
    observedHeadsHeader: string | undefined,
  ): Promise<ValidationFailure | undefined> {
    const observed = parseObservedHeads(observedHeadsHeader);
    if (!observed) return undefined; // evidence absent — nothing to check

    // The start-ref events written at prepare time are the baseline. type
    // 'log' + payload.source 'start-ref', one row per mounted repo.
    const rows = await this.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'log')));

    const startRefs = new Map<string, string>();
    for (const row of rows) {
      const p = row.payload as { source?: string; repo?: string; startSha?: unknown } | null;
      if (p?.source === 'start-ref' && typeof p.repo === 'string' && typeof p.startSha === 'string') {
        startRefs.set(p.repo, p.startSha);
      }
    }
    if (startRefs.size === 0) return undefined; // no baseline — nothing to check

    const violations = detectHandoffViolations(
      startRefs,
      observed,
      normalizeReportArtifacts(report),
      startRefs.size,
    );
    if (violations.length === 0) return undefined;

    const describe = (sha: string): string => sha.slice(0, 7);
    const message =
      'completion rejected: unreported work in ' +
      violations.map((v) => `${v.repo} (${describe(v.startSha)}… → ${describe(v.observedHead)}…)`).join(', ');
    await this.db.insert(schema.runEvents).values({
      runId,
      type: 'log',
      payload: { source: 'handoff-violation', message, violations, outcome: report.outcome },
    });

    return {
      kind: 'validation',
      errors: violations.map((v) => ({
        path: ['artifacts', 'repos'],
        repo: v.repo,
        startSha: v.startSha,
        observedHead: v.observedHead,
        message:
          `repository "${v.repo}" has local commits (started at ${v.startSha}, now ${v.observedHead}) ` +
          `but your report names no branch for it. Push your branch, add an artifacts.repos entry ` +
          `for "${v.repo}", and call complete_task again.`,
      })),
    };
  }

  /**
   * Ticket-level verification receipt (feature 033). Evidence-gated: written
   * only when the completion carried a measured observed-heads header, the run
   * is ticket-bound, and the report has at least one passing check — the
   * exit-time/outbox finalization paths carry no evidence and never reach
   * here. Runs for ALL report outcomes (a failed QA run's honest lint/tsc
   * passes still save the rework run those gates; sha anchoring keeps stale
   * receipts inert). Best-effort by contract: the run is already finalized, so
   * nothing thrown here may undo the completion — every failure only logs.
   */
  private async writeVerificationReceiptBestEffort(
    runId: string,
    report: AgentReport,
    observedHeadsHeader: string | undefined,
  ): Promise<void> {
    try {
      const observed = parseObservedHeads(observedHeadsHeader);
      if (!observed) return;

      const [row] = await this.db
        .select({
          ticketId: schema.runs.ticketId,
          agentRole: schema.agents.role,
          agentName: schema.agents.name,
        })
        .from(schema.runs)
        .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
        .where(eq(schema.runs.id, runId))
        .limit(1);
      if (!row?.ticketId) return;

      const receipt = buildVerificationReceipt(report, observed, {
        runId,
        agentRole: row.agentRole ?? null,
        agentName: row.agentName ?? null,
        recordedAt: new Date().toISOString(),
      });
      if (!receipt) return;

      await this.db
        .update(schema.tickets)
        .set({ verification: receipt })
        .where(eq(schema.tickets.id, row.ticketId));

      const repoList = Object.entries(receipt.repos)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([repo, sha]) => `${repo}@${sha.slice(0, 7)}`)
        .join(', ');
      await this.db.insert(schema.runEvents).values({
        runId,
        type: 'log',
        payload: {
          source: 'verification-receipt',
          message: `Verification receipt saved to the ticket: ${receipt.gates.join(', ')} — verified at ${repoList}`,
          gates: receipt.gates,
          repos: receipt.repos,
          outcome: receipt.outcome,
        },
      });
    } catch (err) {
      this.logger.error(`verification receipt best-effort write failed for run ${runId}: ${String(err)}`);
    }
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

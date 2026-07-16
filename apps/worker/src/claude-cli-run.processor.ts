import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { BRIGADIR_JWT_SECRET } from '@brigadir/app-config';
import { runQueueName, backoffStrategy } from '@brigadir/queues';
import { RunsService, mapExitStatusToRunStatus } from '@brigadir/runs';
import { ExecutorRegistry, type ExecutorResult, type RunContext } from '@brigadir/executors';
import { PipelineService, buildHandoffSection } from '@brigadir/pipeline';
import { signRunToken, type TriggerEvent } from '@brigadir/contracts';
import { JiraClientFactory } from '@brigadir/jira';
import { applyExecutorConcurrency, startConcurrencyReapply } from './executor-concurrency';
import { checkExecutorGate } from './executor-gate';
import { fetchTicketDetail, type TicketDetail } from './ticket-detail';

interface LoadedRun {
  runId: string;
  workspaceId: string;
  executorType: string;
  triggerEvent: unknown;
  instruction: string;
  timeoutMinutes: number;
  maxBudgetUsd: string | null;
  // Null for ticketless workspace-setup runs (feature 011) — tickets left-joined.
  ticketKey: string | null;
  ticketSummary: string | null;
  jiraSiteUrl: string;
  cancelPollMs: number;
  postFinalizeGraceMs: number;
  /** Feature 004 (D6): explicit opt-in to the MCP callback channel. */
  useCallbackChannel: boolean;
}

/** research D5/architecture §4: 5h subscription reset isn't programmatically
 * knowable, so absent a fresher signal we fall back to this heuristic. */
const DEFAULT_RATE_LIMIT_TTL_MS = 15 * 60_000;
const DEFAULT_CANCEL_POLL_MS = 3000;
/**
 * Natural-exit grace after a callback finalize (succeeded/failed) before the
 * cancel-poll aborts the lingering process. The CLI's terminal result event —
 * the ONLY carrier of cost_usd/usage — is printed several seconds AFTER the
 * agent's complete_task callback lands (the model still finishes its turn);
 * killing immediately guarantees the cost data never exists. Bounded so a
 * wedged process can't hold the worker slot: the run timeout still applies.
 */
const DEFAULT_POST_FINALIZE_GRACE_MS = 30_000;
/** Run-token TTL grace beyond the run's own timeout (contracts/run-jwt.md, plan.md). */
const RUN_TOKEN_GRACE_SECONDS = 300;
const DEFAULT_CALLBACK_BASE_URL = 'http://localhost:3000/api/callbacks';

/**
 * ClaudeCliRunProcessor (T083) — consumes `run.claude_cli` jobs. A near-copy
 * of `RunProcessor`: finalization flows through byte-for-byte the same
 * branches (FR-009). The only real difference is that this executor type
 * actually honors `signal` (D2/D4), so this processor owns one
 * `AbortController` per run wired to a timeout `setTimeout` and a DB
 * cancel-poll `setInterval` — cancellation stays "the run row left
 * `running`" (Principle I), no new channel.
 */
@Processor(runQueueName('claude_cli'), {
  // Static fallback only — the real limit is executors.max_parallel_runs,
  // applied at bootstrap (executor-concurrency.ts; decorator args cannot
  // read the DB, CLAUDE.md rule #1).
  concurrency: 2,
  maxStalledCount: 0,
  settings: { backoffStrategy },
})
export class ClaudeCliRunProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ClaudeCliRunProcessor.name);
  private reapplyTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(BRIGADIR_JWT_SECRET) private readonly jwtSecret: string,
    private readonly runs: RunsService,
    private readonly registry: ExecutorRegistry,
    private readonly pipeline: PipelineService,
    private readonly jiraFactory: JiraClientFactory,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await applyExecutorConcurrency(this.db, this.worker, 'claude_cli', this.logger);
    // Live re-apply (FR-025): max_parallel_runs edits take effect ≤ ~15 s with
    // no restart; DB read on each tick (lazy resolution, never at composition).
    this.reapplyTimer = startConcurrencyReapply(this.db, this.worker, 'claude_cli', this.logger);
  }

  onModuleDestroy(): void {
    if (this.reapplyTimer) clearInterval(this.reapplyTimer);
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    const { runId } = job.data;
    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;

    const loaded = await this.load(runId);
    if (!loaded) {
      this.logger.warn(`run ${runId} not found — dropping job`);
      return;
    }

    // Per-profile max_parallel_runs gate (2026-07-14): saturated/disabled
    // profile → back to waiting via the rate-limit path, no attempt burned.
    const gate = await checkExecutorGate(this.db, runId);
    if (!gate.admit) {
      this.logger.log(`run ${runId} held by profile "${gate.profile}" (${gate.reason}) — retrying in ${gate.ttlMs}ms`);
      await this.worker.rateLimit(gate.ttlMs);
      throw Worker.RateLimitError();
    }

    // markRunning guards status ∈ {queued, running}: false means the run is
    // parked (`awaiting_human`) or already finalized — e.g. a BullMQ crash
    // retry landing AFTER a blocking request_human parked the run. Executing
    // the agent again over a parked run would violate the completion contract,
    // so the job is dropped, not retried.
    const startable = await this.runs.markRunning(runId, attempt);
    if (!startable) {
      this.logger.warn(`run ${runId} is not startable (parked or finalized) — dropping job`);
      return;
    }
    await this.pipeline.onRunStarted(runId);

    // Ticket description + browse URL, fetched lazily from Jira (non-fatal).
    // BEFORE the timeout timer starts — fetch time must not eat the run budget.
    // Ticketless setup runs have nothing to fetch (feature 011).
    const detail =
      loaded.ticketKey === null
        ? null
        : await fetchTicketDetail(this.jiraFactory, this.logger, {
            ...loaded,
            ticketKey: loaded.ticketKey,
          });

    const controller = new AbortController();
    // Test/operator override, same established precedent as the mock
    // executor's `rate_limit_ttl_ms` on triggerEvent (TriggerEventSchema is
    // `.passthrough()`): `timeoutMinutes` can only carry whole-minute
    // precision (DB column is `integer`), which can't express the
    // sub-second timeouts an orphan-process test needs to prove a real
    // grandchild gets killed rather than racing the child's own startup.
    const timeoutMsOverride = (loaded.triggerEvent as { timeout_ms_override?: number } | null)
      ?.timeout_ms_override;
    const timeoutMs = timeoutMsOverride ?? loaded.timeoutMinutes * 60_000;
    const timeoutTimer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    // Set on the first poll tick that observes a callback finalize; the abort
    // is deferred until this deadline so the CLI can print its terminal result
    // event (sole carrier of cost_usd/usage) and exit naturally.
    let finalizeGraceDeadline: number | undefined;
    const cancelPoll = setInterval(() => {
      void this.loadStatus(runId)
        .then((status) => {
          if (status === undefined || status === 'running') return;
          if (status === 'succeeded' || status === 'failed') {
            // Legitimate callback finalize — bounded natural-exit grace.
            // Everything else keeps the immediate abort: an explicit user
            // cancel must kill now, and an `awaiting_human` park means the
            // process is wedged on the blocking MCP call and will never
            // exit on its own (D7 — the guarded finalizes make the eventual
            // 'cancelled' outcome a no-op either way).
            finalizeGraceDeadline ??= Date.now() + loaded.postFinalizeGraceMs;
            if (Date.now() < finalizeGraceDeadline) return;
          }
          controller.abort('cancelled');
        })
        // Best-effort poll: a transient DB error (e.g. the pool closing during
        // shutdown/teardown) must not become an unhandled rejection — the run
        // continues and the next tick (or the run finishing) settles it.
        .catch(() => {});
    }, loaded.cancelPollMs);

    // feature 010 (FR-012/014): prepend the ephemeral handoff section for every
    // handoff source — triage, rework, and human-resume (the last replaces the
    // legacy instructionWithResumeAnswer append). Returns '' otherwise.
    const handoff = await buildHandoffSection(loaded.triggerEvent as TriggerEvent | null, this.db);

    let result: ExecutorResult;
    try {
      const executor = this.registry.resolve(loaded.executorType);
      result = await executor.run(this.buildContext(loaded, detail, handoff), controller.signal);
    } catch (err) {
      result = {
        exitStatus: 'crashed',
        diagnostics: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutTimer);
      clearInterval(cancelPoll);
    }

    // Cost/usage are status-independent data columns — persisted once per
    // attempt regardless of which branch (or an earlier callback) owns the
    // status. For callback-wired runs this is the ONLY writer that ever sees
    // cost: the complete_task callback finalized the run before the process
    // exited, so every status-guarded write below is a no-op by then.
    // recordCostUsage is best-effort (never throws) — a throw here would burn
    // the attempt between the executor settling and finalize.
    await this.runs.recordCostUsage(runId, { costUsd: result.costUsd, usage: result.usage });

    if (result.exitStatus === 'completed') {
      if (loaded.useCallbackChannel) {
        // FR-010/011 (D7): callback-wired runs have NO structured-output
        // rescue path — any report-shaped stdout text is diagnostics only,
        // never a finalize source. A 'completed' exit here means the process
        // ended without complete_task/blocking request_human ever landing.
        // Fail closed, guarded WHERE status='running' ONLY: a legitimate
        // awaiting_human park (or an already-finalized run — a callback
        // could have landed a beat before this) is a no-op, never clobbered.
        const diagnostic =
          result.diagnostics ?? 'claude_cli exited without a complete_task or request_human callback';
        const flipped = await this.runs.failIfStillRunning(runId, diagnostic);
        if (flipped) {
          await this.afterFinalize(runId);
        }
        return;
      }

      try {
        await this.runs.finalizeWithReport(runId, result.report, {
          externalRef: result.externalRef,
          costUsd: result.costUsd,
          usage: result.usage,
        });
      } catch (err) {
        // completed without a schema-valid report ⇒ failed (Constitution IV).
        this.logger.error(`invalid report for run ${runId}: ${String(err)}`);
        await this.runs.finalizeStatus(runId, 'failed', { error: `invalid report: ${String(err)}` });
      }
      await this.afterFinalize(runId);
      return;
    }

    const decision = mapExitStatusToRunStatus({
      exitStatus: result.exitStatus,
      attemptsMade: job.attemptsMade,
      maxAttempts,
    });

    switch (decision.action) {
      case 'rate_limit': {
        const ttl = await this.resolveRateLimitTtl(runId, loaded.triggerEvent);
        await this.worker.rateLimit(ttl);
        // Returns the job to waiting WITHOUT consuming an attempt (spec §0.5).
        throw Worker.RateLimitError();
      }
      case 'retry': {
        await this.runs.markQueuedForRetry(runId);
        throw new Error(result.diagnostics ?? 'run crashed — retrying');
      }
      case 'finalize': {
        // Unlike mock, claude_cli legitimately produces cost/usage/externalRef
        // even on a non-`completed` exit (budget-exceeded 'crashed', a
        // timed-out run that got at least one stream event, ...) — data-model.md's
        // field table has no "only if completed" qualifier on cost_usd/usage,
        // so these ride along here too (still the same finalizeStatus/decision
        // control flow as the mock processor — FR-009 — just richer `extra`).
        const extra = {
          error: result.diagnostics,
          externalRef: result.externalRef,
          costUsd: result.costUsd,
          usage: result.usage,
        };
        if (loaded.useCallbackChannel) {
          // D7 generalized: the cancel-poll aborts a lingering process after a
          // blocking request_human parked the run (status left 'running'), and
          // the executor then resolves 'cancelled' — that process outcome must
          // NOT clobber the park. Same for a timeout/crash racing a callback.
          const flipped = await this.runs.finalizeStatusIfRunning(runId, decision.status, extra);
          if (flipped) await this.afterFinalize(runId);
          return;
        }
        await this.runs.finalizeStatus(runId, decision.status, extra);
        await this.afterFinalize(runId);
        return;
      }
    }
  }

  /** Same persist-then-write discipline as RunProcessor (F2). */
  private async afterFinalize(runId: string): Promise<void> {
    try {
      await this.pipeline.onRunFinished(runId);
    } catch (err) {
      this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
    }
  }

  private async loadStatus(runId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    return row?.status;
  }

  /**
   * TTL preference order: an explicit test/operator override on the trigger
   * event, then the CLI's own `retry_delay_ms` (captured in the most recent
   * `api_retry` run_event by the executor — D5), then the architecture §4
   * heuristic for a subscription window whose reset isn't programmatically
   * knowable. `ExecutorResult` is frozen and has no slot for this value, so
   * it necessarily round-trips through the row the executor already wrote.
   */
  private async resolveRateLimitTtl(runId: string, triggerEvent: unknown): Promise<number> {
    const override = (triggerEvent as { rate_limit_ttl_ms?: number } | null)?.rate_limit_ttl_ms;
    if (override !== undefined) return override;

    const [row] = await this.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(desc(schema.runEvents.id))
      .limit(1);

    const payload = row?.payload as { retry_delay_ms?: number } | undefined;
    return payload?.retry_delay_ms ?? DEFAULT_RATE_LIMIT_TTL_MS;
  }

  private async load(runId: string): Promise<LoadedRun | undefined> {
    const [row] = await this.db
      .select({
        runId: schema.runs.id,
        workspaceId: schema.runs.workspaceId,
        executorType: schema.runs.executorType,
        triggerEvent: schema.runs.triggerEvent,
        instruction: schema.agents.instruction,
        timeoutMinutes: schema.agents.timeoutMinutes,
        maxBudgetUsd: schema.agents.maxBudgetUsd,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
        jiraSiteUrl: schema.workspaces.jiraSiteUrl,
        executorConfig: schema.executors.config,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      // Left join: ticketless workspace-setup runs must still dispatch (feature 011).
      .leftJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .innerJoin(schema.workspaces, eq(schema.runs.workspaceId, schema.workspaces.id))
      .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!row) return undefined;

    const executorConfig = row.executorConfig as
      | { cancelPollMs?: number; postFinalizeGraceMs?: number; useCallbackChannel?: boolean }
      | null;
    return {
      runId: row.runId,
      workspaceId: row.workspaceId,
      executorType: row.executorType,
      triggerEvent: row.triggerEvent,
      instruction: row.instruction,
      timeoutMinutes: row.timeoutMinutes,
      maxBudgetUsd: row.maxBudgetUsd,
      ticketKey: row.ticketKey,
      ticketSummary: row.ticketSummary,
      jiraSiteUrl: row.jiraSiteUrl,
      cancelPollMs: executorConfig?.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
      postFinalizeGraceMs: executorConfig?.postFinalizeGraceMs ?? DEFAULT_POST_FINALIZE_GRACE_MS,
      useCallbackChannel: executorConfig?.useCallbackChannel === true,
    };
  }

  private buildContext(loaded: LoadedRun, detail: TicketDetail | null, handoff: string): RunContext {
    const httpBaseUrl = process.env.BRIGADIR_CALLBACK_BASE_URL ?? DEFAULT_CALLBACK_BASE_URL;
    // Real per-run JWT only minted for callback-wired runs (contracts/run-jwt.md);
    // non-callback runs never call the callback API, so the placeholder is inert.
    // The `tkt` claim is informational and omitted for ticketless runs (011 D4).
    const runToken = loaded.useCallbackChannel
      ? signRunToken(
          {
            sub: loaded.runId,
            wsp: loaded.workspaceId,
            ...(loaded.ticketKey === null ? {} : { tkt: loaded.ticketKey }),
            exp: Math.floor(Date.now() / 1000) + loaded.timeoutMinutes * 60 + RUN_TOKEN_GRACE_SECONDS,
          },
          this.jwtSecret,
        )
      : 'claude-cli-run-token';

    return {
      runId: loaded.runId,
      ticket:
        loaded.ticketKey === null
          ? null
          : {
              key: loaded.ticketKey,
              summary: loaded.ticketSummary ?? '',
              description: detail?.description ?? '',
              url: detail?.url ?? '',
            },
      instruction: this.assembleInstruction(loaded, handoff),
      workspaceDir: null,
      callback: { httpBaseUrl, runToken },
      limits: {
        timeoutMs: loaded.timeoutMinutes * 60_000,
        maxBudgetUsd: loaded.maxBudgetUsd !== null ? Number(loaded.maxBudgetUsd) : undefined,
      },
      env: {},
      isResumedAttempt: this.isResumedAttempt(loaded),
    };
  }

  /**
   * A continuation reuses the existing branch/worktree instead of cutting a
   * fresh one. Both a human-resume and a rework are continuations of prior work
   * on the same ticket (feature 010, FR-014/T052).
   */
  private isResumedAttempt(loaded: LoadedRun): boolean {
    const source = (loaded.triggerEvent as { source?: string } | null)?.source;
    return source === 'human-resume' || source === 'rework';
  }

  /**
   * Assemble the run instruction: the stored agent instruction, prefixed with
   * the ephemeral handoff section (triage / rework / human-resume — FR-012/014).
   * The human's answer arrives via the handoff's "human answer" block, replacing
   * the legacy resume-answer append. The stored `instruction` row is never
   * modified (SC-002).
   */
  private assembleInstruction(loaded: LoadedRun, handoff: string): string {
    return handoff ? `${handoff}\n\n${loaded.instruction}` : loaded.instruction;
  }
}

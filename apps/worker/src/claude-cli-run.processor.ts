import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { runQueueName, backoffStrategy } from '@brigadir/queues';
import { RunsService, mapExitStatusToRunStatus } from '@brigadir/runs';
import { ExecutorRegistry, type ExecutorResult, type RunContext } from '@brigadir/executors';
import { PipelineService } from '@brigadir/pipeline';

interface LoadedRun {
  runId: string;
  executorType: string;
  triggerEvent: unknown;
  instruction: string;
  timeoutMinutes: number;
  maxBudgetUsd: string | null;
  ticketKey: string;
  ticketSummary: string | null;
  cancelPollMs: number;
}

/** research D5/architecture §4: 5h subscription reset isn't programmatically
 * knowable, so absent a fresher signal we fall back to this heuristic. */
const DEFAULT_RATE_LIMIT_TTL_MS = 15 * 60_000;
const DEFAULT_CANCEL_POLL_MS = 3000;

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
  concurrency: 2,
  maxStalledCount: 0,
  settings: { backoffStrategy },
})
export class ClaudeCliRunProcessor extends WorkerHost {
  private readonly logger = new Logger(ClaudeCliRunProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runs: RunsService,
    private readonly registry: ExecutorRegistry,
    private readonly pipeline: PipelineService,
  ) {
    super();
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

    await this.runs.markRunning(runId, attempt);
    await this.pipeline.onRunStarted(runId);

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
    const cancelPoll = setInterval(() => {
      void this.isStillActive(runId).then((active) => {
        if (!active) controller.abort('cancelled');
      });
    }, loaded.cancelPollMs);

    let result: ExecutorResult;
    try {
      const executor = this.registry.resolve(loaded.executorType);
      result = await executor.run(this.buildContext(loaded), controller.signal);
    } catch (err) {
      result = {
        exitStatus: 'crashed',
        diagnostics: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutTimer);
      clearInterval(cancelPoll);
    }

    if (result.exitStatus === 'completed') {
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
        await this.runs.finalizeStatus(runId, decision.status, {
          error: result.diagnostics,
          externalRef: result.externalRef,
          costUsd: result.costUsd,
          usage: result.usage,
        });
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

  private async isStillActive(runId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    return row?.status === 'running';
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
        executorType: schema.runs.executorType,
        triggerEvent: schema.runs.triggerEvent,
        instruction: schema.agents.instruction,
        timeoutMinutes: schema.agents.timeoutMinutes,
        maxBudgetUsd: schema.agents.maxBudgetUsd,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
        executorConfig: schema.executors.config,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .innerJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!row) return undefined;

    const executorConfig = row.executorConfig as { cancelPollMs?: number } | null;
    return {
      runId: row.runId,
      executorType: row.executorType,
      triggerEvent: row.triggerEvent,
      instruction: row.instruction,
      timeoutMinutes: row.timeoutMinutes,
      maxBudgetUsd: row.maxBudgetUsd,
      ticketKey: row.ticketKey,
      ticketSummary: row.ticketSummary,
      cancelPollMs: executorConfig?.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
    };
  }

  private buildContext(loaded: LoadedRun): RunContext {
    return {
      runId: loaded.runId,
      ticket: {
        key: loaded.ticketKey,
        summary: loaded.ticketSummary ?? '',
        description: '',
        url: '',
      },
      instruction: loaded.instruction,
      workspaceDir: null,
      callback: { httpBaseUrl: 'http://localhost:3000/api/callbacks', runToken: 'claude-cli-run-token' },
      limits: {
        timeoutMs: loaded.timeoutMinutes * 60_000,
        maxBudgetUsd: loaded.maxBudgetUsd !== null ? Number(loaded.maxBudgetUsd) : undefined,
      },
      env: {},
    };
  }
}

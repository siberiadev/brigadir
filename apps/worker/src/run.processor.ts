import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { runQueueName, backoffStrategy } from '@brigadir/queues';
import { RunsService, mapExitStatusToRunStatus } from '@brigadir/runs';
import { ExecutorRegistry, type ExecutorResult, type RunContext } from '@brigadir/executors';
import { PipelineService } from '@brigadir/pipeline';
import { applyExecutorConcurrency, startConcurrencyReapply } from './executor-concurrency';
import { checkExecutorGate } from './executor-gate';

interface LoadedRun {
  runId: string;
  executorType: string;
  triggerEvent: unknown;
  instruction: string;
  timeoutMinutes: number;
  ticketKey: string;
  ticketSummary: string | null;
}

/**
 * RunProcessor (T026) — consumes `run.mock` jobs. Loads run+agent+ticket, marks
 * `running`, runs the resolved executor, and applies the D4 status mapping:
 *  - completed → validated report → succeeded|failed|awaiting_human
 *  - rate_limited → `worker.rateLimit(ttl)` + RateLimitError (no attempt burned)
 *  - crashed → throw for BullMQ retry (same row, attempt+1); failed on exhaustion
 *  - timeout|cancelled → finalize terminal
 *
 * `maxStalledCount: 0` (spec §0.5 — runs are non-idempotent, never silently re-run).
 */
@Processor(runQueueName('mock'), {
  // Static fallback only — the real limit is executors.max_parallel_runs,
  // applied at bootstrap (executor-concurrency.ts).
  concurrency: 2,
  maxStalledCount: 0,
  settings: { backoffStrategy },
})
export class RunProcessor extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunProcessor.name);
  private reapplyTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runs: RunsService,
    private readonly registry: ExecutorRegistry,
    private readonly pipeline: PipelineService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await applyExecutorConcurrency(this.db, this.worker, 'mock', this.logger);
    // Live re-apply (FR-025): a max_parallel_runs edit takes effect ≤ ~15 s
    // with no restart. The DB is read on each tick (lazy resolution).
    this.reapplyTimer = startConcurrencyReapply(this.db, this.worker, 'mock', this.logger);
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

    await this.runs.markRunning(runId, attempt);
    // Optional in-progress Jira transition at job start (non-fatal on failure).
    await this.pipeline.onRunStarted(runId);

    let result: ExecutorResult;
    try {
      const executor = this.registry.resolve(loaded.executorType);
      result = await executor.run(this.buildContext(loaded), new AbortController().signal);
    } catch (err) {
      result = {
        exitStatus: 'crashed',
        diagnostics: err instanceof Error ? err.message : String(err),
      };
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
        const ttl =
          (loaded.triggerEvent as { rate_limit_ttl_ms?: number } | null)?.rate_limit_ttl_ms ?? 200;
        await this.worker.rateLimit(ttl);
        // Returns the job to waiting WITHOUT consuming an attempt (spec §0.5).
        throw Worker.RateLimitError();
      }
      case 'retry': {
        await this.runs.markQueuedForRetry(runId);
        throw new Error(result.diagnostics ?? 'run crashed — retrying');
      }
      case 'finalize': {
        await this.runs.finalizeStatus(runId, decision.status, { error: result.diagnostics });
        await this.afterFinalize(runId);
        return;
      }
    }
  }

  /**
   * Persist-then-write (FR-022, closes F2): the run result is already persisted;
   * now drive the Jira side (transition + ADF comment). A Jira failure MUST NOT
   * fail the job or burn an attempt — it is logged and left for reconcile drift
   * repair to re-apply (the run stays terminal, its result intact).
   */
  private async afterFinalize(runId: string): Promise<void> {
    try {
      await this.pipeline.onRunFinished(runId);
    } catch (err) {
      this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
    }
  }

  private async load(runId: string): Promise<LoadedRun | undefined> {
    const [row] = await this.db
      .select({
        runId: schema.runs.id,
        executorType: schema.runs.executorType,
        triggerEvent: schema.runs.triggerEvent,
        instruction: schema.agents.instruction,
        timeoutMinutes: schema.agents.timeoutMinutes,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .innerJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    return row;
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
      callback: { httpBaseUrl: 'http://localhost:3000/api/callbacks', runToken: 'mock-run-token' },
      limits: { timeoutMs: loaded.timeoutMinutes * 60_000 },
      env: {},
    };
  }
}

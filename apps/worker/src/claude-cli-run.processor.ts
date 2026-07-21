import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema, getBrigadirAgentTemplate } from '@brigadir/database';
import { BRIGADIR_JWT_SECRET } from '@brigadir/app-config';
import { runQueueName, backoffStrategy } from '@brigadir/queues';
import { RunsService, mapExitStatusToRunStatus } from '@brigadir/runs';
import {
  ExecutorRegistry,
  RepositoryScopeUndeterminableError,
  composeScopeQuestion,
  resolveMcpConfigRoot,
  readOutboxReport,
  consumeOutbox,
  createMemoizedArtifactGuard,
  formatArtifactGuardError,
  type MemoizedArtifactGuard,
  type ExecutorResult,
  type RunContext,
} from '@brigadir/executors';
import { HumanTaskService } from '@brigadir/human-tasks';
import { PipelineService, buildHandoffSection } from '@brigadir/pipeline';
import { ReportSchema, signRunToken, type AgentReport, type TriggerEvent } from '@brigadir/contracts';
// feature 026 (research D10): the single scrubbing audit point, reused so the
// outbox reconcile paths persist reports through the exact same scrubber as a
// live callback.
import { scrubAgentReport } from '@brigadir/callback';
import { attachUndeliveredReport } from './undelivered-report';
import { ingestChannelBreadcrumbs } from './channel-breadcrumb-ingest';
import { ChannelProbe } from './channel-probe';
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
/**
 * Floor for a park window (incident 2026-07-19, kimi/Moonshot). `retry_delay_ms`
 * is whatever the CLI puts in its `api_retry` event, and that is NOT always a
 * provider-supplied Retry-After: against Moonshot the CLI reports its OWN
 * client-side jittered backoff — a sub-second FLOAT (e.g. 577.7599559849516).
 * Two ways that broke us, both fixed by sanitizing here:
 *   1. A float reached `worker.rateLimit()` → BullMQ issues `SET ... PX <float>`
 *      → Redis replies "ERR value is not an integer or out of range". That
 *      ReplyError is thrown INSTEAD of `Worker.RateLimitError()`, so the park
 *      never happens, the attempt IS burned (spec §0.5 promises it is not), and
 *      the run row is left in 'running' forever with the job in `failed`.
 *   2. Even valid, a ~0.5s park is not a park: the job requeues immediately and
 *      re-does the whole workspace preparation (~17s of clone/worktree work per
 *      cycle) only to hit the same limit — a hot loop that burns provider quota.
 * A park exists to wait out a limit, so it must dominate the requeue cost. The
 * explicit operator/test override is deliberately NOT clamped — it is exact by
 * construction (see integration `rate_limit_ttl_ms` fixtures).
 */
const MIN_RATE_LIMIT_TTL_MS = 60_000;
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
const DEFAULT_CALLBACK_BASE_URL = 'http://127.0.0.1:3000/api/callbacks';

/**
 * Pure: CLI-reported `retry_delay_ms` → a park TTL safe to hand to BullMQ.
 * Non-numeric/non-finite (absent event, malformed payload) falls back to the
 * §4 heuristic rather than parking for a nonsense duration.
 */
export function sanitizeRateLimitTtl(reported: unknown): number {
  if (typeof reported !== 'number' || !Number.isFinite(reported)) {
    return DEFAULT_RATE_LIMIT_TTL_MS;
  }
  // Integer for Redis `PX`, floored so a park always outlasts a requeue.
  return Math.max(Math.ceil(reported), MIN_RATE_LIMIT_TTL_MS);
}

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
  // Feature 027: consumption is gated by the exclusive worker lock
  // (WorkerLockBootstrap starts the run loop only once the lock is held).
  autorun: false,
})
export class ClaudeCliRunProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  /**
   * Which executor profiles feed this processor's concurrency budget
   * (feature 025): the kimi subclass overrides this to 'kimi'. Everything
   * else — gate, finalization branches, guards — is shared verbatim; the
   * registry already resolves the right executor per run from the run row's
   * own `executor_type`.
   */
  protected readonly executorType: string = 'claude_cli';
  private readonly logger = new Logger(this.constructor.name);
  private reapplyTimer?: NodeJS.Timeout;
  // Feature 026 (US2): memoized deployment guard consulted per callback-wired
  // pickup. TTL overridable so integration tests can prove a rebuild heals the
  // worker without a restart within one poll.
  private readonly artifactGuard: MemoizedArtifactGuard = createMemoizedArtifactGuard(
    Number(process.env.BRIGADIR_ARTIFACT_GUARD_TTL_MS) || 10_000,
  );
  // Feature 026 (US4): pre-flight callback-channel probe (in-memory backoff
  // counters, one instance per processor).
  private readonly channelProbe = new ChannelProbe();

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(BRIGADIR_JWT_SECRET) private readonly jwtSecret: string,
    private readonly runs: RunsService,
    private readonly registry: ExecutorRegistry,
    private readonly pipeline: PipelineService,
    private readonly jiraFactory: JiraClientFactory,
    // Feature 020: the repo-scoping gate parks undeterminable-scope runs.
    private readonly humanTasks: HumanTaskService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await applyExecutorConcurrency(this.db, this.worker, this.executorType, this.logger);
    // Live re-apply (FR-025): max_parallel_runs edits take effect ≤ ~15 s with
    // no restart; DB read on each tick (lazy resolution, never at composition).
    this.reapplyTimer = startConcurrencyReapply(this.db, this.worker, this.executorType, this.logger);
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

    // Feature 026 (US2, deployment guard): only callback-wired runs need the
    // agent tool-server artifact. A missing/stale artifact fails the run
    // LOUDLY here — before the gate, before markRunning, before any spawn —
    // rather than letting agents run a stale binary (the 3f60c1a1 root cause).
    // The run is still 'queued', so a plain guarded finalizeStatus owns the
    // status cleanly (no attempt consumed elsewhere). Mock/Phase-0 runs skip
    // this entirely. A rebuild heals within the guard's memo TTL, no restart.
    if (loaded.useCallbackChannel) {
      const verdict = await this.artifactGuard.check(Date.now());
      if (!verdict.ok) {
        const message = formatArtifactGuardError(verdict);
        this.logger.error(`run ${runId}: ${message}`);
        await this.runs.finalizeStatus(runId, 'failed', { error: message });
        await this.afterFinalize(runId);
        return;
      }
    }

    // Feature 026 (US4, pre-flight channel check): a callback-wired run must
    // not burn its 20-minute budget against a provably-dead channel. Probe the
    // callback endpoint BEFORE the gate / markRunning; a dead channel holds the
    // run via the rate-limit path (job back to waiting, NO attempt consumed,
    // status stays 'queued') with backoff and an operator-visible channel_down
    // event. Recovers automatically when the endpoint is back. Protects against
    // environment outages (backend down), not client-side bugs (spec limit).
    if (loaded.useCallbackChannel) {
      const alive = await this.channelProbe.probe();
      if (!alive) {
        const ttl = await this.channelProbe.recordFailure(this.db, runId, this.logger);
        await this.worker.rateLimit(ttl);
        throw Worker.RateLimitError();
      }
      this.channelProbe.recordSuccess(runId);
    }

    // Per-profile / per-model max_parallel_runs gate (2026-07-14; model tier
    // incident 2026-07-19 Phase 5): saturated/disabled profile OR a model at
    // its configured cap → back to waiting via the rate-limit path, no attempt
    // burned.
    const gate = await checkExecutorGate(this.db, runId, this.logger);
    if (!gate.admit) {
      const heldBy = gate.model ? `profile "${gate.profile}" model "${gate.model}"` : `profile "${gate.profile}"`;
      this.logger.log(`run ${runId} held by ${heldBy} (${gate.reason}) — retrying in ${gate.ttlMs}ms`);
      await this.worker.rateLimit(gate.ttlMs);
      throw Worker.RateLimitError();
    }
    // Overload signal (Phase 5, G3): admitted while ≥75% of the tightest
    // applicable limit is occupied — operator-visible pressure building.
    if (gate.nearCapacity) {
      const { limitKind, running, limit } = gate.nearCapacity;
      this.logger.warn(`run ${runId} admitted near capacity: ${limitKind} limit ${running}/${limit} (≥75%)`);
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
    const handoff = await buildHandoffSection(loaded.triggerEvent as TriggerEvent | null, this.db, {
      workspaceId: loaded.workspaceId,
    });

    let result: ExecutorResult;
    try {
      const executor = this.registry.resolve(loaded.executorType);
      result = await executor.run(this.buildContext(loaded, detail, handoff), controller.signal);
    } catch (err) {
      // Feature 020 (D2): an undeterminable repository scope parks the run to
      // the human queue with a case-specific question — it is NOT a crash. The
      // executor threw BEFORE any clone/worktree/spawn work; the guarded park
      // (WHERE status='running') owns the run status from here, so this path
      // finalizes nothing (CLAUDE.md rule 7). Falls through to the crashed
      // mapping only if parking itself failed.
      if (err instanceof RepositoryScopeUndeterminableError && (await this.parkForScope(runId, err))) {
        return;
      }
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
        // Feature 026 (US1, the 3f60c1a1 case): a 'completed' exit while the
        // run is still 'running' means no complete_task/request_human callback
        // landed. Before failing closed, check the durable outbox — the agent
        // may have computed a verdict and written it locally when the HTTP
        // callback could not be delivered. A valid report finalizes through
        // the SAME guarded path as a live callback (validation, checks, human
        // tasks); a present-but-invalid file is left on disk for inspection
        // (FR-007) and we fall through to fail-closed.
        const outbox = await this.loadOutboxReport(runId);
        if (outbox.kind === 'valid') {
          const reconciled = await this.runs.finalizeWithReport(runId, outbox.report, {
            costUsd: result.costUsd,
            usage: result.usage,
          });
          // flip → the outbox verdict finalized this run; no-flip → a live
          // callback (or park) already owns it. Either way the report is
          // delivered, so consume the file and skip the fail-closed write.
          await this.consumeOutbox(runId);
          if (reconciled) await this.afterFinalize(runId);
          // Feature 027 (US3): терминальная ветка — перелить breadcrumb-файл
          // канала (если был) в run_events; best-effort, статус не трогает.
          await ingestChannelBreadcrumbs(this.db, runId, 'exit');
          return;
        }
        // FR-010/011 (D7): no valid outbox report — fail closed, guarded WHERE
        // status='running' ONLY: a legitimate awaiting_human park (or an
        // already-finalized run) is a no-op, never clobbered.
        const diagnostic =
          result.diagnostics ?? 'claude_cli exited without a complete_task or request_human callback';
        const flipped = await this.runs.failIfStillRunning(runId, diagnostic);
        if (flipped) {
          await this.afterFinalize(runId);
        }
        // Feature 027 (US3): fail-closed — тоже терминальная ветка.
        await ingestChannelBreadcrumbs(this.db, runId, 'exit');
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
          // Durable-finalize outbox (Phase 4, Problem 6; widened feature 026
          // US1): a run about to become `timed_out` may already carry a
          // `complete_task` report that never reached the backend (the
          // incident's `fetch failed`). The run is still `running` here, so
          // finalizing from the outbox goes through the normal guarded path —
          // reconcile it instead of losing the outcome. The report is scrubbed
          // first (Constitution V — this path previously bypassed the
          // scrubber, feature 026 research D10). Only `timed_out`:
          // `cancelled`/`rate_limited` are intentional stops that must not be
          // clobbered by a local report.
          if (decision.status === 'timed_out') {
            const outbox = await this.loadOutboxReport(runId);
            if (outbox.kind === 'valid') {
              const reconciled = await this.runs.finalizeWithReport(runId, outbox.report, extra);
              if (reconciled) {
                await this.consumeOutbox(runId);
                await this.afterFinalize(runId);
                return;
              }
              // no-flip: a callback already owns the run — the report is
              // delivered, so consume and fall through (the guarded write below
              // is then a no-op).
              await this.consumeOutbox(runId);
            }
            // 'invalid' / 'absent' ⇒ leave the file on disk (FR-007) and fall
            // through to the unchanged `timed_out` path below.
          }
          // Feature 026 (US1): a `cancelled` stop is intentional — never flip
          // the status — but a present outbox verdict must not be silently
          // discarded. Attach it as an operator-visible undelivered_report and
          // consume the file so the periodic reconciler won't reprocess it.
          if (decision.status === 'cancelled') {
            const outbox = await this.loadOutboxReport(runId);
            if (outbox.kind === 'valid') {
              await attachUndeliveredReport(this.db, runId, outbox.report, 'cancelled', 'exit_reconcile');
              await this.consumeOutbox(runId);
            }
          }
          // D7 generalized: the cancel-poll aborts a lingering process after a
          // blocking request_human parked the run (status left 'running'), and
          // the executor then resolves 'cancelled' — that process outcome must
          // NOT clobber the park. Same for a timeout/crash racing a callback.
          const flipped = await this.runs.finalizeStatusIfRunning(runId, decision.status, extra);
          if (flipped) await this.afterFinalize(runId);
          // Feature 027 (US3): любой финализирующий исход callback-wired
          // прогона переливает breadcrumb-файл канала в run_events.
          await ingestChannelBreadcrumbs(this.db, runId, 'exit');
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

  /**
   * Feature 026 (US1): read the durable outbox report for a run and classify
   * it. `valid` carries the schema-validated + scrubbed report ready for the
   * same finalize path a live callback uses; `invalid` (present but fails
   * ReportSchema) and `absent` (no readable file) both leave the file on disk
   * so a malformed verdict is preserved for inspection (FR-007). The config
   * root is resolved lazily (Constitution lazy-resolution) so it matches the
   * writer's dir in prod and a per-suite scratch dir under test.
   */
  private async loadOutboxReport(
    runId: string,
  ): Promise<{ kind: 'valid'; report: AgentReport } | { kind: 'invalid' } | { kind: 'absent' }> {
    const raw = await readOutboxReport(resolveMcpConfigRoot(), runId);
    if (raw === null) return { kind: 'absent' };
    try {
      return { kind: 'valid', report: scrubAgentReport(ReportSchema.parse(raw)) };
    } catch {
      return { kind: 'invalid' };
    }
  }

  /** Best-effort removal of a consumed outbox file (feature 026). */
  private async consumeOutbox(runId: string): Promise<void> {
    await consumeOutbox(resolveMcpConfigRoot(), runId);
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
   * The CLI-reported value is untrusted input — see `MIN_RATE_LIMIT_TTL_MS`.
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
    return sanitizeRateLimitTtl(payload?.retry_delay_ms);
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

    // feature 015 (FR-013/019, D9): a workspace-setup run takes its timeout
    // from the LIVE brigadir template's setup profile (sized to accommodate
    // repository clones), not the agent's triage timeout. Flowing it through
    // `timeoutMinutes` covers the abort timer, the run-token TTL, and
    // ctx.limits.timeoutMs in one place.
    let timeoutMinutes = row.timeoutMinutes;
    if ((row.triggerEvent as { source?: string } | null)?.source === 'workspace-setup') {
      timeoutMinutes = (await getBrigadirAgentTemplate(this.db)).setup.timeout_minutes;
    }

    const executorConfig = row.executorConfig as
      | { cancelPollMs?: number; postFinalizeGraceMs?: number; useCallbackChannel?: boolean }
      | null;
    return {
      runId: row.runId,
      workspaceId: row.workspaceId,
      executorType: row.executorType,
      triggerEvent: row.triggerEvent,
      instruction: row.instruction,
      timeoutMinutes,
      maxBudgetUsd: row.maxBudgetUsd,
      ticketKey: row.ticketKey,
      ticketSummary: row.ticketSummary,
      jiraSiteUrl: row.jiraSiteUrl,
      cancelPollMs: executorConfig?.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
      postFinalizeGraceMs: executorConfig?.postFinalizeGraceMs ?? DEFAULT_POST_FINALIZE_GRACE_MS,
      useCallbackChannel: executorConfig?.useCallbackChannel === true,
    };
  }

  /**
   * Feature 020 (D2): park a run whose repository scope the gate could not
   * determine. Delegates to HumanTaskService.createFromRequest — guarded park
   * (`running` → `awaiting_human` only), one-open-task dedup, Jira
   * blocked-status transition + question comment through the per-issue write
   * queue. Title/details are system-composed from display-safe fields only
   * (ticket key + component/repository names — FR-009, feature-010 precedent).
   * Returns false when parking itself failed, so the caller can fail the run
   * loudly instead of leaving it running forever.
   */
  private async parkForScope(runId: string, err: RepositoryScopeUndeterminableError): Promise<boolean> {
    const question = composeScopeQuestion(err.scopeCase, err.display);
    this.logger.warn(
      `run ${runId}: repository scope undeterminable for ${err.display.ticketKey} (${err.scopeCase}) — parking to the human queue`,
    );
    try {
      await this.humanTasks.createFromRequest(runId, {
        kind: 'blocker',
        blocking: true,
        title: question.title,
        details: question.details,
      });
      return true;
    } catch (parkErr) {
      this.logger.error(`run ${runId}: scope-gate parking failed: ${String(parkErr)}`);
      return false;
    }
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
              components: detail?.components ?? null,
            },
      instruction: this.assembleInstruction(loaded, handoff),
      workspaceDir: null,
      callback: { httpBaseUrl, runToken },
      limits: {
        timeoutMs: loaded.timeoutMinutes * 60_000,
        maxBudgetUsd: loaded.maxBudgetUsd !== null ? Number(loaded.maxBudgetUsd) : undefined,
      },
      env: {},
    };
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

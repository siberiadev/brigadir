import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JiraClientFactory, buildRunComment, NoTransitionPath } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { HumanTaskService } from '@brigadir/human-tasks';
import type { AgentReport, JiraIssue, TriggerEvent } from '@brigadir/contracts';
import { evaluateDependencyGate, blockingKeys } from './dependency-gate';
import { getReworkBudget } from './rework-budget';

/** Where a status change came from (internal to the pipeline; distinct from the persisted trigger source). */
export type StatusChangeSource = 'poller' | 'webhook' | 'scope_entry';

export interface OnStatusChangedInput {
  ticketId: string;
  issue: JiraIssue;
  fromStatus: string | null;
  toStatus: string;
  source: StatusChangeSource;
}

/**
 * PipelineService (contracts.md C6). Two seams:
 *
 * - `onStatusChanged`: match enabled agents by `trigger_status == toStatus`,
 *   apply the dependency gate, and trigger the clear ones via RunTriggerService
 *   (the three dedup layers make it fire exactly once). Ingest and (future)
 *   webhook both converge here — idempotent by construction.
 * - `onRunFinished`: persist-then-write (FR-022, closes F2). Called AFTER the
 *   run result is persisted; reads run+agent+ticket, transitions the ticket to
 *   the success/failure status and posts the ADF checklist comment, then writes
 *   the `run_events(type='jira_action')` marker. All Jira writes go through the
 *   JiraClient (Principle III). Idempotent: the marker guard makes a repeat
 *   call (e.g. drift repair) a no-op once the writes have landed.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    // Per-workspace client (feature 006 checkpoint): finalization writes for
    // workspace B must hit B's Jira site — the global LIMIT-1 client is wrong
    // the moment a second workspace exists. Resolved lazily per write.
    private readonly jiraFactory: JiraClientFactory,
    private readonly runTrigger: RunTriggerService,
    // feature 010: triage-limit / routing-override / orchestrator-failure
    // fallbacks land as non-blocking human tasks (FR-005/009/010).
    private readonly humanTasks: HumanTaskService,
  ) {}

  async onStatusChanged(input: OnStatusChangedInput): Promise<void> {
    const { ticketId, issue, toStatus, source } = input;

    const [ticket] = await this.db
      .select({ workspaceId: schema.tickets.workspaceId, jiraKey: schema.tickets.jiraKey })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);
    if (!ticket) {
      this.logger.warn(`onStatusChanged: ticket ${ticketId} not found`);
      return;
    }

    const agents = await this.db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        behavior: schema.agents.behavior,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, ticket.workspaceId),
          eq(schema.agents.triggerStatus, toStatus),
          eq(schema.agents.enabled, true),
        ),
      );
    if (agents.length === 0) return;

    if (evaluateDependencyGate(issue) === 'blocked') {
      this.logger.log(
        `${ticket.jiraKey} entered "${toStatus}" but is blocked by [${blockingKeys(issue).join(', ')}] — trigger skipped (${agents.length} agent(s))`,
      );
      return;
    }

    for (const agent of agents) {
      const triggerEvent = buildAgentTriggerEvent(source, agent.behavior);
      const result = await this.runTrigger.trigger({ ticketId, agentId: agent.id, triggerEvent });
      if (result.deduplicated) {
        this.logger.log(
          `${ticket.jiraKey} → agent "${agent.name}": trigger deduplicated (existing run ${result.existingRunId ?? '?'})`,
        );
      } else {
        this.logger.log(`${ticket.jiraKey} → agent "${agent.name}": run ${result.runId} enqueued`);
      }
    }
  }

  /**
   * Optional in-progress transition at job start (data-model.md). If the agent
   * defines `status_running`, move the ticket into it when the run begins. A
   * failure here is non-fatal — it is logged and the run proceeds (the terminal
   * transition still happens in onRunFinished).
   */
  async onRunStarted(runId: string): Promise<void> {
    const [run] = await this.db
      .select({
        agentId: schema.runs.agentId,
        ticketId: schema.runs.ticketId,
        workspaceId: schema.runs.workspaceId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) return;

    const [agent] = await this.db
      .select({ statusRunning: schema.agents.statusRunning })
      .from(schema.agents)
      .where(eq(schema.agents.id, run.agentId))
      .limit(1);
    if (!agent?.statusRunning) return;

    const [ticket] = await this.db
      .select({ jiraKey: schema.tickets.jiraKey })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, run.ticketId))
      .limit(1);
    if (!ticket) return;

    try {
      const jira = await this.jiraFactory.forWorkspace(run.workspaceId);
      await jira.transitionTo(ticket.jiraKey, agent.statusRunning);
      this.logger.log(`run ${runId}: ${ticket.jiraKey} → running status "${agent.statusRunning}"`);
    } catch (err) {
      this.logger.warn(`run ${runId}: running-status transition failed (non-fatal): ${String(err)}`);
    }
  }

  async onRunFinished(runId: string): Promise<void> {
    // Idempotency / drift-repair safety: if the pending Jira write already
    // landed (marker present), do nothing.
    if (await this.hasJiraActionMarker(runId)) return;

    const [run] = await this.db
      .select({
        status: schema.runs.status,
        report: schema.runs.report,
        error: schema.runs.error,
        agentId: schema.runs.agentId,
        ticketId: schema.runs.ticketId,
        workspaceId: schema.runs.workspaceId,
        triggerEvent: schema.runs.triggerEvent,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) {
      this.logger.warn(`onRunFinished: run ${runId} not found`);
      return;
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      // Not terminal yet — nothing to write. (Shouldn't happen on the happy path.)
      return;
    }

    const [agent] = await this.db
      .select({
        name: schema.agents.name,
        statusSuccess: schema.agents.statusSuccess,
        statusFailure: schema.agents.statusFailure,
        isOrchestrator: schema.agents.isOrchestrator,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, run.agentId))
      .limit(1);
    const [ticket] = await this.db
      .select({ jiraKey: schema.tickets.jiraKey })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, run.ticketId))
      .limit(1);
    if (!agent || !ticket) {
      this.logger.warn(`onRunFinished: agent/ticket missing for run ${runId}`);
      return;
    }

    // feature 010 (FR-007): a completed ORCHESTRATOR run takes NONE of the
    // generic success/failure transitions — its decision drives the ticket.
    if (agent.isOrchestrator) {
      await this.onOrchestratorFinished(runId, run, agent, ticket.jiraKey);
      return;
    }

    await this.onWorkerFinished(runId, run, agent, ticket.jiraKey);
  }

  /**
   * Generic worker completion (pre-feature-010 behavior) + the triage trigger.
   * A terminally-failed worker run, AFTER its failure transition + comment and
   * BEFORE the completion marker, starts exactly one in-process triage run for
   * the workspace's enabled orchestrator (FR-004); the decision is recorded in
   * the marker so drift-repair replays are no-ops (SC-001).
   */
  private async onWorkerFinished(
    runId: string,
    run: LoadedRun,
    agent: LoadedAgent,
    jiraKey: string,
  ): Promise<void> {
    const rawReport = (run.report as AgentReport | null) ?? syntheticFailureReport(run.error);
    // FR-002 (AC US2-5): only the orchestrator may route. A worker returning
    // `routed` is invalid — treat it as a failure with the reason in the comment.
    const invalidRouted = rawReport.outcome === 'routed';
    const report = invalidRouted ? invalidRoutedReport(rawReport) : rawReport;
    const succeeded = run.status === 'succeeded' && !invalidRouted;
    const targetStatus = succeeded ? agent.statusSuccess : agent.statusFailure;

    try {
      // Resolved inside the try: a credential-decode failure rethrows like any
      // Jira error → the caller logs and drift repair retries next pass.
      const jira = await this.jiraFactory.forWorkspace(run.workspaceId);
      await jira.transitionTo(jiraKey, targetStatus);
      await jira.addComment(jiraKey, buildRunComment(report));

      // FR-004: terminally-failed worker run → triage decision. Runs after the
      // failure transition + comment, before the marker.
      let triageDecision: string | undefined;
      if (run.status === 'failed' || run.status === 'timed_out') {
        triageDecision = await this.decideTriage(runId, run);
      }

      await this.db.insert(schema.runEvents).values({
        runId,
        type: 'jira_action',
        payload: {
          transitioned_to: targetStatus,
          commented: true,
          ...(triageDecision ? { triage_decision: triageDecision } : {}),
        },
      });
      this.logger.log(
        `run ${runId}: ${jiraKey} → "${targetStatus}" + checklist comment posted` +
          (triageDecision ? ` (triage: ${triageDecision})` : ''),
      );
    } catch (err) {
      if (err instanceof NoTransitionPath) {
        // Board-config fault (FR-008): record the diagnostic against the (already
        // failed/terminal) run. No marker written → a later reconcile pass retries,
        // self-healing once the board workflow is fixed.
        this.logger.error(`run ${runId}: ${err.message}`);
        await this.db.insert(schema.runEvents).values({
          runId,
          type: 'error',
          payload: { stage: 'jira_transition', error: err.message },
        });
        return;
      }
      throw err;
    }
  }

  /**
   * The triage decision for a terminally-failed worker run (FR-004/005, D4-D6).
   * - budget exhausted ⇒ `cycle_limit`: non-blocking human task, no triage.
   * - no enabled orchestrator ⇒ `no_orchestrator`: the supported off-switch —
   *   ticket stays in its failure status, no human task (spec Edge Cases;
   *   data-model §3.2). Decision recorded for the marker only.
   * - otherwise ⇒ `triaged`: exactly one triage run for the orchestrator,
   *   enqueued through RunTriggerService (inherits the three dedup layers).
   */
  private async decideTriage(failingRunId: string, run: LoadedRun): Promise<string> {
    const budget = await getReworkBudget(this.db, run.ticketId, run.workspaceId);
    if (!budget.available) {
      await this.humanTasks.createNonBlocking(failingRunId, {
        kind: 'blocker',
        title: 'Rework budget exhausted — manual attention needed',
        details: `This ticket has used its ${budget.max} rework cycle(s); automated triage was skipped.`,
      });
      return 'cycle_limit';
    }

    const orchestrator = await this.findEnabledOrchestrator(run.workspaceId);
    if (!orchestrator) {
      return 'no_orchestrator';
    }

    const scenario = mockScenarioOf(orchestrator.behavior);
    const routeTarget = routeTargetOf(orchestrator.behavior);
    await this.runTrigger.trigger({
      ticketId: run.ticketId,
      agentId: orchestrator.id,
      triggerEvent: {
        source: 'triage',
        failing_run_id: failingRunId,
        ...(scenario ? { mock_scenario: scenario } : {}),
        ...(routeTarget ? { target_agent: routeTarget } : {}),
      } as TriggerEvent,
    });
    return 'triaged';
  }

  /**
   * A completed orchestrator run: process its decision (FR-007..011). No generic
   * transition; every branch writes its own `jira_action` marker so a drift
   * replay no-ops. Jira/enqueue failures throw (no marker) → retried next pass.
   */
  private async onOrchestratorFinished(
    runId: string,
    run: LoadedRun,
    agent: LoadedAgent,
    jiraKey: string,
  ): Promise<void> {
    const decision = await this.processOrchestratorDecision(runId, run, agent, jiraKey);
    await this.db.insert(schema.runEvents).values({
      runId,
      type: 'jira_action',
      payload: { orchestrator_decision: decision, transitioned: decision === 'routed' },
    });
    this.logger.log(`orchestrator run ${runId}: ${jiraKey} decision=${decision}`);
  }

  private async processOrchestratorDecision(
    runId: string,
    run: LoadedRun,
    agent: LoadedAgent,
    jiraKey: string,
  ): Promise<string> {
    // FR-010: the triager is never triaged. A failed/timed-out orchestrator run
    // creates no second triage — just a human task describing the failure.
    if (run.status === 'failed' || run.status === 'timed_out') {
      await this.humanTasks.createNonBlocking(runId, {
        kind: 'blocker',
        title: 'Orchestrator triage run failed — manual triage needed',
        details: `The orchestrator ("${agent.name}") run ${run.status}. Decide how to proceed with this ticket manually.`,
      });
      return 'orchestrator_failed';
    }

    const report = run.report as AgentReport | null;

    // FR-011: an orchestrator "needs human" already parked the run and created
    // its human task via the existing mechanism (finalizeWithReport). No ticket
    // transition — the ticket already sits in the failure status.
    if (run.status === 'awaiting_human' || report?.outcome === 'needs_human') {
      return 'needs_human';
    }

    // routed is the only remaining valid outcome (routed ⇒ succeeded). Anything
    // else from an orchestrator is unexpected → treat like an orchestrator failure.
    if (report?.outcome !== 'routed' || !report.routing) {
      await this.humanTasks.createNonBlocking(runId, {
        kind: 'blocker',
        title: 'Orchestrator returned an unexpected outcome — manual triage needed',
        details: `The orchestrator ("${agent.name}") did not return a routing decision. Decide how to proceed manually.`,
      });
      return 'orchestrator_invalid';
    }

    const routing = report.routing;
    const target = await this.resolveRoutingTarget(run.workspaceId, routing.target_agent);
    const budget = await getReworkBudget(this.db, run.ticketId, run.workspaceId);

    // FR-009: invalid target or exhausted budget ⇒ override to a human task
    // carrying the orchestrator's task text + the override reason.
    if (!target || !budget.available) {
      const reason = !target
        ? `target agent "${routing.target_agent}" is not a valid, enabled worker in this workspace`
        : `rework budget exhausted (${budget.cycleCount} of ${budget.max})`;
      await this.humanTasks.createNonBlocking(runId, {
        kind: 'blocker',
        title: 'Routing overridden — manual attention needed',
        details: `${routing.task}\n\nOverride reason: ${reason}.`,
      });
      return target ? 'override_budget' : 'override_invalid_target';
    }

    // FR-008: valid routing ⇒ enqueue the rework run, transition the ticket to
    // the target's running status directly (never through a trigger status), and
    // post a routing comment naming the target + task.
    const failingRunId = (run.triggerEvent as { failing_run_id?: string } | null)?.failing_run_id;
    const targetScenario = mockScenarioOf(target.behavior);
    await this.runTrigger.trigger({
      ticketId: run.ticketId,
      agentId: target.id,
      triggerEvent: {
        source: 'rework',
        deciding_run_id: runId,
        target_agent: routing.target_agent,
        task: routing.task,
        ...(failingRunId ? { failing_run_id: failingRunId } : {}),
        ...(targetScenario ? { mock_scenario: targetScenario } : {}),
      } as TriggerEvent,
    });

    const jira = await this.jiraFactory.forWorkspace(run.workspaceId);
    if (target.statusRunning) {
      await jira.transitionTo(jiraKey, target.statusRunning);
    }
    await jira.addComment(jiraKey, buildRunComment(report));
    return 'routed';
  }

  private async findEnabledOrchestrator(
    workspaceId: string,
  ): Promise<{ id: string; behavior: unknown } | undefined> {
    const [row] = await this.db
      .select({ id: schema.agents.id, behavior: schema.agents.behavior })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, workspaceId),
          eq(schema.agents.isOrchestrator, true),
          eq(schema.agents.enabled, true),
        ),
      )
      .limit(1);
    return row;
  }

  /** Target validity (FR-008): exists ∧ enabled ∧ non-orchestrator ∧ same workspace. */
  private async resolveRoutingTarget(
    workspaceId: string,
    name: string,
  ): Promise<{ id: string; statusRunning: string | null; behavior: unknown } | undefined> {
    const [row] = await this.db
      .select({
        id: schema.agents.id,
        statusRunning: schema.agents.statusRunning,
        behavior: schema.agents.behavior,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, workspaceId),
          eq(schema.agents.name, name),
          eq(schema.agents.enabled, true),
          eq(schema.agents.isOrchestrator, false),
        ),
      )
      .limit(1);
    return row;
  }

  private async hasJiraActionMarker(runId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: schema.runEvents.id })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'jira_action')))
      .limit(1);
    return rows.length > 0;
  }
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'awaiting_human']);

/** The `runs` fields onRunFinished's helpers read (feature 010). */
interface LoadedRun {
  status: string;
  report: unknown;
  error: string | null;
  agentId: string;
  ticketId: string;
  workspaceId: string;
  triggerEvent: unknown;
}

/** The `agents` fields onRunFinished's helpers read. */
interface LoadedAgent {
  name: string;
  statusSuccess: string;
  statusFailure: string;
  isOrchestrator: boolean;
}

function mockScenarioOf(behavior: unknown): string | undefined {
  const s = (behavior as { mock_scenario?: unknown } | null)?.mock_scenario;
  return typeof s === 'string' ? s : undefined;
}

/**
 * Test convenience: which worker the mock orchestrator routes to. The mock
 * `routed` report reads `trigger_event.target_agent`, so the orchestrator's
 * intended target rides from its `behavior.route_target` into the triage
 * trigger. Real orchestrators decide the target themselves and ignore this.
 */
function routeTargetOf(behavior: unknown): string | undefined {
  const t = (behavior as { route_target?: unknown } | null)?.route_target;
  return typeof t === 'string' ? t : undefined;
}

/** FR-002: recast a non-orchestrator `routed` report as a failure with the reason noted. */
function invalidRoutedReport(report: AgentReport): AgentReport {
  return {
    schema_version: 1,
    outcome: 'failure',
    summary:
      'Agent returned an invalid "routed" outcome — only the orchestrator may route a ticket. ' +
      `Original summary: ${report.summary}`,
    checks: report.checks,
    ...(report.artifacts ? { artifacts: report.artifacts } : {}),
  };
}

/**
 * Build the trigger event for an agent match. `mock_scenario` is threaded from
 * the agent's `behavior` blob when present so integration tests can drive the
 * full loop to each outcome; real executors ignore it (it stays inert in prod,
 * where agents carry no `mock_scenario`). Exported so the reconcile dependency
 * re-evaluation step produces identical trigger events.
 */
export function buildAgentTriggerEvent(source: StatusChangeSource, behavior: unknown): TriggerEvent {
  const b = (behavior ?? {}) as Record<string, unknown>;
  const scenario = typeof b.mock_scenario === 'string' ? b.mock_scenario : undefined;
  return {
    source: source === 'webhook' ? 'webhook' : 'poll',
    ...(scenario ? { mock_scenario: scenario } : {}),
  } as TriggerEvent;
}

/** A run finalized without a structured report (timeout/crash) still gets a failure comment. */
function syntheticFailureReport(error: string | null): AgentReport {
  return {
    schema_version: 1,
    outcome: 'failure',
    summary: error ? `Run did not complete: ${error}` : 'Run did not complete successfully.',
    checks: [],
  };
}

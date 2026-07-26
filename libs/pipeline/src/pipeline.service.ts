import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema, getDependencyReleaseStatus } from '@brigadir/database';
import { JiraClientFactory, buildRunComment, NoTransitionPath } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { HumanTaskService } from '@brigadir/human-tasks';
import type { AgentReport, JiraBoardType, JiraIssue, TriggerEvent } from '@brigadir/contracts';
import {
  evaluateDependencyGate,
  blockingKeys,
  allBlockedByKeys,
  earlyReleaseBlockers,
} from './dependency-gate';
import {
  buildAgentTriggerEvent,
  DependencyReleaseService,
  recordEarlyRelease,
} from './dependency-release.service';
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
    // feature 022: post-success fast path — release the finished ticket's
    // dependents immediately instead of waiting for the next reconcile pass.
    private readonly release: DependencyReleaseService,
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
    if (agents.length === 0) {
      // Not a trigger status (anymore) — the ticket cannot be blocked-waiting
      // (feature 022 FR-001 clear rule). Cheap guarded write: only rows that
      // actually carry a waiting state are touched.
      await this.clearWaitingState(ticketId);
      return;
    }

    // Feature 032 (FR-003): the SAME threshold the release pass uses — read once
    // per event. `undefined` ⇒ no option passed ⇒ pre-032 behaviour (FR-016).
    const releaseStatus = await getDependencyReleaseStatus(this.db, ticket.workspaceId);
    const gateOpts = { releaseStatus };

    if (evaluateDependencyGate(issue, gateOpts) === 'blocked') {
      // Feature 022 (FR-001): persist the waiting state instead of dropping the
      // event — the release pass keeps it current and the dashboard reads it.
      // Feature 032: `blocked_by` records EVERY observed link (an observation,
      // not a waiting flag); the log still names only what actually gates.
      const blockers = blockingKeys(issue, gateOpts);
      await this.db
        .update(schema.tickets)
        .set({ blockedBy: allBlockedByKeys(issue), blockedState: 'waiting' })
        .where(eq(schema.tickets.id, ticketId));
      this.logger.log(
        `${ticket.jiraKey} entered "${toStatus}" but is blocked by [${blockers.join(', ')}] — waiting (${agents.length} agent(s))`,
      );
      return;
    }

    // FR-015: which blockers cleared only by the configured status name.
    const early = earlyReleaseBlockers(issue, gateOpts);
    // Feature 032: the observation is written even on the clear path, so a
    // ticket that never waited still carries its chain for inheritance. This
    // subsumes clearWaitingState's guarded write here — the row is being
    // touched regardless, so there is nothing left to guard against.
    await this.db
      .update(schema.tickets)
      .set({ blockedBy: allBlockedByKeys(issue), blockedState: null })
      .where(eq(schema.tickets.id, ticketId));
    for (const agent of agents) {
      const triggerEvent = buildAgentTriggerEvent(source, agent.behavior);
      const result = await this.runTrigger.trigger({ ticketId, agentId: agent.id, triggerEvent });
      if (result.deduplicated) {
        this.logger.log(
          `${ticket.jiraKey} → agent "${agent.name}": trigger deduplicated (existing run ${result.existingRunId ?? '?'})`,
        );
      } else {
        this.logger.log(`${ticket.jiraKey} → agent "${agent.name}": run ${result.runId} enqueued`);
        if (early.length > 0 && releaseStatus) {
          await recordEarlyRelease(this.db, result.runId, releaseStatus, early);
        }
      }
    }
  }

  /**
   * Feature 022 (FR-003): fire-and-forget release of the just-completed
   * ticket's dependents. Never throws — a failure here is logged and the next
   * reconcile pass releases them anyway (pull is the guarantee).
   */
  private async releaseDependentsSafely(workspaceId: string, jiraKey: string): Promise<void> {
    try {
      const [ws] = await this.db
        .select({
          projectKey: schema.workspaces.jiraProjectKey,
          boardId: schema.workspaces.jiraBoardId,
          boardType: schema.workspaces.jiraBoardType,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      // Board not introspected yet → no scope to build; the reconcile pass owns it.
      if (!ws?.boardType) return;
      const jira = await this.jiraFactory.forWorkspace(workspaceId);
      await this.release.releaseDependentsOf(
        {
          id: workspaceId,
          projectKey: ws.projectKey,
          boardId: ws.boardId,
          boardType: ws.boardType as JiraBoardType,
        },
        jira,
        jiraKey,
      );
    } catch (err) {
      this.logger.warn(
        `fast-path release after ${jiraKey} failed (non-fatal, reconcile pass will retry): ${String(err)}`,
      );
    }
  }

  /**
   * Feature 022: drop the waiting cache for a ticket that is no longer
   * blocked-waiting. Feature 032 narrowed it to `blocked_state` ONLY:
   * `blocked_by` is now an observation that must survive (data-model.md §2) —
   * the dependent's prepare step reads it long after the ticket stopped waiting.
   */
  private async clearWaitingState(ticketId: string): Promise<void> {
    await this.db
      .update(schema.tickets)
      .set({ blockedState: null })
      .where(and(eq(schema.tickets.id, ticketId), sql`${schema.tickets.blockedState} is not null`));
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
    // Ticketless workspace-setup runs (feature 011): no ticket, no transition.
    if (run.ticketId === null) return;

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
    if (!agent) {
      this.logger.warn(`onRunFinished: agent missing for run ${runId}`);
      return;
    }

    // Feature 011 (D10): a ticketless run is a workspace-setup run — no Jira
    // side at all; the completion is marker-only (+ failure human task).
    if (run.ticketId === null) {
      if (!agent.isOrchestrator) {
        // Cannot happen through any trigger path today — logged, not thrown.
        this.logger.warn(`onRunFinished: ticketless run ${runId} on a non-orchestrator agent — skipped`);
        return;
      }
      await this.onSetupFinished(runId, run, agent);
      return;
    }

    const [ticket] = await this.db
      .select({ jiraKey: schema.tickets.jiraKey })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, run.ticketId))
      .limit(1);
    if (!ticket) {
      this.logger.warn(`onRunFinished: ticket missing for run ${runId}`);
      return;
    }

    // feature 010 (FR-007): a completed ORCHESTRATOR run takes NONE of the
    // generic success/failure transitions — its decision drives the ticket.
    if (agent.isOrchestrator) {
      await this.onOrchestratorFinished(runId, run, run.ticketId, agent, ticket.jiraKey);
      return;
    }

    await this.onWorkerFinished(runId, run, run.ticketId, agent, ticket.jiraKey);
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
    ticketId: string,
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
        triageDecision = await this.decideTriage(runId, ticketId, run.workspaceId);
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

      // Feature 022 (FR-003 fast path): a successful completion may have just
      // unblocked dependents — release them now instead of waiting a reconcile
      // interval. Strictly non-fatal: the reconcile pass is the guarantee.
      if (succeeded) {
        await this.releaseDependentsSafely(run.workspaceId, jiraKey);
      }
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
  private async decideTriage(
    failingRunId: string,
    ticketId: string,
    workspaceId: string,
  ): Promise<string> {
    const budget = await getReworkBudget(this.db, ticketId, workspaceId);
    if (!budget.available) {
      await this.humanTasks.createNonBlocking(failingRunId, {
        kind: 'blocker',
        title: 'Rework budget exhausted — manual attention needed',
        details: `This ticket has used its ${budget.max} rework cycle(s); automated triage was skipped.`,
      });
      return 'cycle_limit';
    }

    const orchestrator = await this.findEnabledOrchestrator(workspaceId);
    if (!orchestrator) {
      return 'no_orchestrator';
    }

    const scenario = mockScenarioOf(orchestrator.behavior);
    const routeTarget = routeTargetOf(orchestrator.behavior);
    await this.runTrigger.trigger({
      ticketId,
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
    ticketId: string,
    agent: LoadedAgent,
    jiraKey: string,
  ): Promise<void> {
    const decision = await this.processOrchestratorDecision(runId, run, ticketId, agent, jiraKey);
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
    ticketId: string,
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
    const budget = await getReworkBudget(this.db, ticketId, run.workspaceId);

    // Answer-triage delta: a human explicitly answered and picked the
    // orchestrator, which itself grants ONE more rework cycle — this decision's
    // rework run is exempt from the exhausted-budget override. It still counts
    // in run history, so the NEXT automatic triage escalates `cycle_limit`.
    // The automatic fail-triage cap (decideTriage) is unchanged.
    const humanGranted =
      (run.triggerEvent as { source?: string } | null)?.source === 'answer-triage';

    // FR-009: invalid target or exhausted budget ⇒ override to a human task
    // carrying the orchestrator's task text + the override reason.
    if (!target || (!budget.available && !humanGranted)) {
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
    const trigger = run.triggerEvent as
      | { failing_run_id?: string; human_task_id?: string }
      | null;
    const failingRunId = trigger?.failing_run_id;
    // Traceability (answer-triage delta): the human task whose answer drove
    // this decision rides along into the rework run.
    const humanTaskId = trigger?.human_task_id;
    const targetScenario = mockScenarioOf(target.behavior);
    await this.runTrigger.trigger({
      ticketId,
      agentId: target.id,
      triggerEvent: {
        source: 'rework',
        deciding_run_id: runId,
        target_agent: routing.target_agent,
        task: routing.task,
        ...(failingRunId ? { failing_run_id: failingRunId } : {}),
        ...(humanTaskId ? { human_task_id: humanTaskId } : {}),
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

  /**
   * Feature 011 (D10): a finished workspace-setup run. There is no Jira side at
   * all on this path — the accept path (`SetupApplyService` inside
   * `finalizeWithReport`) already validated and applied the team + review task
   * in one transaction — so completion processing only records the marker
   * (drift-repair replays no-op on it) and turns a failed/timed-out setup run
   * into a ticketless human task. The triager is never triaged (FR-010 spirit):
   * `decideTriage` is unreachable here by construction.
   */
  private async onSetupFinished(runId: string, run: LoadedRun, agent: LoadedAgent): Promise<void> {
    let setup: string;
    let agentsCreated: number | undefined;

    if (run.status === 'failed' || run.status === 'timed_out') {
      const issues = lastValidationIssues(run.error);
      await this.humanTasks.createNonBlocking(runId, {
        kind: 'blocker',
        title: 'Workspace setup failed — team not generated',
        details:
          `The orchestrator ("${agent.name}") setup run ${run.status === 'failed' ? 'failed' : 'timed out'}.` +
          (issues ? `\n\n${issues}` : '') +
          '\n\nFix the problem and press "Generate agents" again — no agents were created.',
      });
      setup = 'failed';
    } else if (run.status === 'awaiting_human') {
      // Parked on a blocking question — resolving the task resumes setup as a
      // fresh workspace-setup run (ResumeService), which gets its own marker.
      setup = 'needs_human';
    } else {
      const report = run.report as AgentReport | null;
      agentsCreated = report?.outcome === 'team' ? (report.team?.agents.length ?? 0) : 0;
      setup = 'applied';
    }

    await this.db.insert(schema.runEvents).values({
      runId,
      type: 'jira_action',
      payload: { setup, ...(agentsCreated !== undefined ? { agents_created: agentsCreated } : {}) },
    });
    this.logger.log(
      `setup run ${runId}: ${setup}` + (agentsCreated !== undefined ? ` (${agentsCreated} agent(s))` : ''),
    );
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

  /**
   * Resolve `routing.target_agent` (feature 014: the target's KEY) to an agent id.
   * Target validity (FR-008): exists ∧ enabled ∧ non-orchestrator ∧ same workspace.
   * Matching by key — the LLM echoes the readable handle reliably; the reserved
   * orchestrator key ("brigadir") is excluded by the is_orchestrator filter.
   */
  private async resolveRoutingTarget(
    workspaceId: string,
    key: string,
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
          eq(schema.agents.key, key),
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
  // Null for ticketless workspace-setup runs (feature 011).
  ticketId: string | null;
  workspaceId: string;
  triggerEvent: unknown;
}

/**
 * The fail-closed error of a setup run that never landed an accepted proposal
 * carries the last 422 issue list (runs.error) — surface it in the human task.
 */
function lastValidationIssues(error: string | null): string | undefined {
  if (!error) return undefined;
  return `Last error:\n${error}`;
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

/** A run finalized without a structured report (timeout/crash) still gets a failure comment. */
function syntheticFailureReport(error: string | null): AgentReport {
  return {
    schema_version: 1,
    outcome: 'failure',
    summary: error ? `Run did not complete: ${error}` : 'Run did not complete successfully.',
    checks: [],
  };
}

import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JiraClientFactory, buildRunComment, NoTransitionPath } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import type { AgentReport, JiraIssue, TriggerEvent } from '@brigadir/contracts';
import { evaluateDependencyGate, blockingKeys } from './dependency-gate';

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
        statusSuccess: schema.agents.statusSuccess,
        statusFailure: schema.agents.statusFailure,
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

    const succeeded = run.status === 'succeeded';
    const targetStatus = succeeded ? agent.statusSuccess : agent.statusFailure;
    const report = (run.report as AgentReport | null) ?? syntheticFailureReport(run.error);

    try {
      // Resolved inside the try: a credential-decode failure rethrows like any
      // Jira error → the caller logs and drift repair retries next pass.
      const jira = await this.jiraFactory.forWorkspace(run.workspaceId);
      await jira.transitionTo(ticket.jiraKey, targetStatus);
      await jira.addComment(ticket.jiraKey, buildRunComment(report));
      await this.db.insert(schema.runEvents).values({
        runId,
        type: 'jira_action',
        payload: { transitioned_to: targetStatus, commented: true },
      });
      this.logger.log(
        `run ${runId}: ${ticket.jiraKey} → "${targetStatus}" + checklist comment posted`,
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

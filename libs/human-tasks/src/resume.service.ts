import { Injectable, Inject, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JiraClientFactory } from '@brigadir/jira';
import { runQueueName } from '@brigadir/queues';
import type { ResolveHumanTaskInput } from '@brigadir/contracts';

export type ResolveResult =
  | { outcome: 'resumed'; newRunId: string }
  | { outcome: 'closed' }
  | { outcome: 'not_found' }
  | { outcome: 'not_open' }
  // feature 010 (FR-015, AC US3-3): target_agent_id present but invalid
  // (missing / disabled / other workspace) — nothing changes.
  | { outcome: 'invalid_target' }
  // SXF-1174 Problem 6 (per-ticket runs_one_active): another run became active
  // on the ticket while resolving — race-only (the index forbids a parked run
  // coexisting with another active run at rest). Task stays open/resumable.
  | { outcome: 'active_run_conflict' };

/** Internal result of the supersede+insert transaction. */
type ResumeRunResult =
  | { kind: 'resumed'; id: string }
  | { kind: 'gone' }
  | { kind: 'conflict' };

/** The resolved, validated resume target agent (feature 010). */
interface ResumeTarget {
  id: string;
  executorType: string;
  // answer-triage delta: picking the orchestrator as the resume target creates
  // an answer-triage run instead of a plain human-resume run.
  isOrchestrator: boolean;
  behavior: unknown;
}

/**
 * ResumeService (FR-016/017/018/019). Resolving a blocking human task:
 * - `resume` — ONE transaction: close the parked run `superseded`, insert a
 *   new attempt (attempt+1, `queued`) carrying the human's answer in
 *   `trigger_event` (FR-018). The supersede lands WITHIN the same
 *   transaction as the insert so `runs_one_active` never rejects the new
 *   row (FR-016). After commit: enqueue (dedup — Constitution II level 2 —
 *   new trigger sources pass through the same three layers) and transition
 *   the ticket to the running status, never back through the trigger status
 *   (FR-017, non-fatal like the existing onRunStarted transition).
 * - `done_manually` / `dismiss` — close the task and its parked run without
 *   a new attempt and without an automated ticket transition (FR-019).
 *
 * Answer-triage delta: when the EFFECTIVE resume target is the workspace
 * orchestrator ("brigadir" — the picker's default), the new run is an
 * `answer-triage` run instead: the orchestrator reads the Q&A + the failing
 * run's report in its handoff and routes via the ordinary `routed` contract.
 * Its `statusRunning` is NULL, so no ticket transition happens here — the
 * routed decision transitions the ticket to the rework target's status.
 */
@Injectable()
export class ResumeService {
  private readonly logger = new Logger(ResumeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    // Per-workspace client (feature 006 checkpoint) — the resume transition
    // must hit the parked run's own workspace site.
    private readonly jiraFactory: JiraClientFactory,
    private readonly moduleRef: ModuleRef,
  ) {}

  async resolve(taskId: string, input: ResolveHumanTaskInput): Promise<ResolveResult> {
    const [task] = await this.db
      .select()
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.id, taskId))
      .limit(1);
    if (!task) return { outcome: 'not_found' };
    if (task.status !== 'open') return { outcome: 'not_open' };

    if (input.action === 'resume') {
      if (!task.blocking || !task.runId) {
        await this.closeTask(taskId, 'resolved', input);
        return { outcome: 'closed' };
      }
      // feature 011 (D12): a ticketless (workspace-setup) task has no ticket to
      // route — resume always re-creates a setup run; a target agent is invalid.
      if (input.target_agent_id && task.ticketId === null) {
        return { outcome: 'invalid_target' };
      }
      // feature 010 (FR-015): an optional target agent. Validate BEFORE touching
      // any row so an invalid id changes nothing (AC US3-3).
      let target: ResumeTarget | undefined;
      if (input.target_agent_id) {
        target = await this.resolveTargetAgent(task.workspaceId, input.target_agent_id);
        if (!target) return { outcome: 'invalid_target' };
      }
      const resumed = await this.resumeRun(task.runId, input.answer, taskId, target);
      if (resumed.kind === 'conflict') return { outcome: 'active_run_conflict' };
      if (resumed.kind === 'gone') return { outcome: 'not_open' };
      await this.closeTask(taskId, 'resolved', input);
      return { outcome: 'resumed', newRunId: resumed.id };
    }

    // done_manually | dismiss — close the parked run (if any), no new attempt.
    if (task.blocking && task.runId) {
      await this.db
        .update(schema.runs)
        .set({ status: 'superseded', finishedAt: sql`now()` })
        .where(and(eq(schema.runs.id, task.runId), eq(schema.runs.status, 'awaiting_human')));
    }
    await this.closeTask(taskId, input.action === 'dismiss' ? 'dismissed' : 'resolved', input);
    return { outcome: 'closed' };
  }

  private async closeTask(
    taskId: string,
    status: 'resolved' | 'dismissed',
    input: ResolveHumanTaskInput,
  ): Promise<void> {
    await this.db
      .update(schema.humanTasks)
      .set({
        status,
        resolution: input.answer ?? null,
        resolvedAt: sql`now()`,
        resolvedBy: input.resolved_by ?? null,
      })
      .where(eq(schema.humanTasks.id, taskId));
  }

  /** Target validity (FR-015): exists ∧ enabled ∧ same workspace. */
  private async resolveTargetAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<ResumeTarget | undefined> {
    const [row] = await this.db
      .select({
        id: schema.agents.id,
        executorType: schema.executors.type,
        isOrchestrator: schema.agents.isOrchestrator,
        behavior: schema.agents.behavior,
      })
      .from(schema.agents)
      .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
      .where(
        and(
          eq(schema.agents.id, agentId),
          eq(schema.agents.workspaceId, workspaceId),
          eq(schema.agents.enabled, true),
        ),
      )
      .limit(1);
    return row;
  }

  private async resumeRun(
    parkedRunId: string,
    answer: string | undefined,
    humanTaskId: string,
    target: ResumeTarget | undefined,
  ): Promise<ResumeRunResult> {
    const [parked] = await this.db
      .select({
        workspaceId: schema.runs.workspaceId,
        ticketId: schema.runs.ticketId,
        agentId: schema.runs.agentId,
        attempt: schema.runs.attempt,
        executorType: schema.runs.executorType,
        triggerEvent: schema.runs.triggerEvent,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, parkedRunId))
      .limit(1);
    if (!parked) return { kind: 'gone' };

    // A different chosen agent runs on its own executor profile with the attempt
    // count restarted at 1 (FR-015); resuming the original agent keeps attempt+1.
    const differentAgent = target !== undefined && target.id !== parked.agentId;
    const newAgentId = target?.id ?? parked.agentId;
    const newExecutorType = target?.executorType ?? parked.executorType;
    const newAttempt = differentAgent ? 1 : parked.attempt + 1;

    // answer-triage delta: the EFFECTIVE agent (chosen target, else the parked
    // run's own agent) decides the trigger shape — an orchestrator gets an
    // answer-triage run carrying the Q&A + failure reference; a worker keeps the
    // plain human-resume trigger. Keyed off the effective agent (not just
    // `target`) because the web guard suppresses `target_agent_id` when it
    // equals the original agent — a parked ORCHESTRATOR run resumed with no
    // explicit target must still re-triage, not plain-resume.
    const [parkedAgent] = await this.db
      .select({
        isOrchestrator: schema.agents.isOrchestrator,
        behavior: schema.agents.behavior,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, parked.agentId))
      .limit(1);
    const parkedIsOrchestrator = parkedAgent?.isOrchestrator ?? false;
    const effectiveIsOrchestrator = target ? target.isOrchestrator : parkedIsOrchestrator;
    const effectiveBehavior = target ? target.behavior : parkedAgent?.behavior;

    // feature 011 (FR-020/D12): a parked workspace-setup run resumes as ANOTHER
    // setup run carrying the Q&A — never answer-triage (there is no failing
    // worker run to route, and no ticket).
    const parkedSource = (parked.triggerEvent as { source?: string } | null)?.source;
    const isSetupResume = parkedSource === 'workspace-setup';

    const triggerEvent = isSetupResume
      ? {
          source: 'workspace-setup',
          human_task_id: humanTaskId,
          resolution: answer ?? null,
          ...(mockScenarioOf(effectiveBehavior)
            ? { mock_scenario: mockScenarioOf(effectiveBehavior) }
            : {}),
        }
      : effectiveIsOrchestrator
      ? answerTriageTriggerEvent({
          parkedRunId,
          parkedTriggerEvent: parked.triggerEvent,
          parkedIsOrchestrator,
          humanTaskId,
          answer,
          behavior: effectiveBehavior,
        })
      : {
          // human_task_id lets the handoff section render the question + answer
          // (FR-016); the answer also rides in `resolution` (legacy consumers).
          source: 'human-resume',
          resolution: answer ?? null,
          human_task_id: humanTaskId,
        };

    let newRunId: string | undefined;
    try {
      await this.db.transaction(async (tx) => {
        const superseded = await tx
          .update(schema.runs)
          .set({ status: 'superseded', finishedAt: sql`now()` })
          .where(and(eq(schema.runs.id, parkedRunId), eq(schema.runs.status, 'awaiting_human')))
          .returning({ id: schema.runs.id });
        if (superseded.length === 0) return; // race: no longer awaiting_human — bail, newRunId stays undefined

        const [inserted] = await tx
          .insert(schema.runs)
          .values({
            workspaceId: parked.workspaceId,
            ticketId: parked.ticketId,
            agentId: newAgentId,
            executorType: newExecutorType,
            status: 'queued',
            attempt: newAttempt,
            triggerEvent,
          })
          .returning({ id: schema.runs.id });
        newRunId = inserted.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // SXF-1174 Problem 6: per-ticket runs_one_active — another run became
        // active on the ticket between our supersede and insert (race-only:
        // at rest the index forbids parked + other-active coexisting). The tx
        // rolled back, so the parked run is still awaiting_human and the task
        // stays open — the human can resume again once the conflict resolves.
        this.logger.warn(
          `resume of run ${parkedRunId} hit runs_one_active — another run is active on the ticket`,
        );
        return { kind: 'conflict' };
      }
      throw err;
    }

    if (!newRunId) return { kind: 'gone' };

    // No BullMQ `deduplication` option here (unlike RunTriggerService): the
    // dedup key is tied to the JOB's retained Redis lifetime, not the
    // logical trigger — the original (completed-but-retained,
    // removeOnComplete keeps history) job under the same
    // `${ticketId}:${agentId}` key would silently swallow this add. Not
    // needed anyway: the guarded supersede+insert transaction above already
    // guarantees at most one enqueue per successful resume (Constitution II
    // level 3, DB-authoritative) — a concurrent duplicate resolve() call
    // sees 0 superseded rows and bails before ever reaching this line.
    const queue = this.moduleRef.get<Queue>(getQueueToken(runQueueName(newExecutorType)), { strict: false });
    await queue.add('run', { runId: newRunId }, { jobId: newRunId });

    await this.transitionToRunning(parked.workspaceId, newAgentId, parked.ticketId, newRunId);

    return { kind: 'resumed', id: newRunId };
  }

  private async transitionToRunning(
    workspaceId: string,
    agentId: string,
    ticketId: string | null,
    newRunId: string,
  ): Promise<void> {
    // Ticketless setup resume (feature 011): nothing to transition.
    if (ticketId === null) return;
    const [agent] = await this.db
      .select({ statusRunning: schema.agents.statusRunning })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    if (!agent?.statusRunning) return;

    const [ticket] = await this.db
      .select({ jiraKey: schema.tickets.jiraKey })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);
    if (!ticket) return;

    try {
      const jira = await this.jiraFactory.forWorkspace(workspaceId);
      await jira.transitionTo(ticket.jiraKey, agent.statusRunning);
    } catch (err) {
      this.logger.warn(`resume: running-status transition failed (non-fatal) for run ${newRunId}: ${String(err)}`);
    }
  }
}

/**
 * The trigger event for a human-initiated triage run (answer-triage delta):
 * the human resolved a blocking task with the orchestrator as the resume
 * target, so the new run carries the Q&A alongside the failing-run reference
 * for the handoff, and marks the eventual rework run as human-granted (budget
 * exemption in `processOrchestratorDecision`).
 *
 * `failing_run_id`: the parked run — its report is what the orchestrator should
 * read. When the parked run is itself an ORCHESTRATOR run (brigadir's own
 * needs_human), its report is just the question; the original worker failure
 * carried in ITS trigger event is the useful context, so that reference is
 * forwarded instead (falling back to the parked run id).
 */
function answerTriageTriggerEvent(opts: {
  parkedRunId: string;
  parkedTriggerEvent: unknown;
  parkedIsOrchestrator: boolean;
  humanTaskId: string;
  answer: string | undefined;
  behavior: unknown;
}): Record<string, unknown> {
  const forwarded = opts.parkedIsOrchestrator
    ? (opts.parkedTriggerEvent as { failing_run_id?: string } | null)?.failing_run_id
    : undefined;
  const scenario = mockScenarioOf(opts.behavior);
  const routeTarget = routeTargetOf(opts.behavior);
  return {
    source: 'answer-triage',
    failing_run_id: forwarded ?? opts.parkedRunId,
    human_task_id: opts.humanTaskId,
    resolution: opts.answer ?? null,
    ...(scenario ? { mock_scenario: scenario } : {}),
    ...(routeTarget ? { target_agent: routeTarget } : {}),
  };
}

// Local copies of the tiny behavior readers in libs/pipeline/src/pipeline.service.ts
// (`mockScenarioOf`/`routeTargetOf`) — importing them would create a lib cycle
// (pipeline already depends on human-tasks). Keep the three in sync.
function mockScenarioOf(behavior: unknown): string | undefined {
  const s = (behavior as { mock_scenario?: unknown } | null)?.mock_scenario;
  return typeof s === 'string' ? s : undefined;
}

function routeTargetOf(behavior: unknown): string | undefined {
  const t = (behavior as { route_target?: unknown } | null)?.route_target;
  return typeof t === 'string' ? t : undefined;
}

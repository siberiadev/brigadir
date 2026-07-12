import { Injectable, Inject, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JIRA_CLIENT, type JiraClient } from '@brigadir/jira';
import { runQueueName } from '@brigadir/queues';
import type { ResolveHumanTaskInput } from '@brigadir/contracts';

export type ResolveResult =
  | { outcome: 'resumed'; newRunId: string }
  | { outcome: 'closed' }
  | { outcome: 'not_found' }
  | { outcome: 'not_open' };

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
 */
@Injectable()
export class ResumeService {
  private readonly logger = new Logger(ResumeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(JIRA_CLIENT) private readonly jira: JiraClient,
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
      const newRunId = await this.resumeRun(task.runId, input.answer);
      if (!newRunId) return { outcome: 'not_open' };
      await this.closeTask(taskId, 'resolved', input);
      return { outcome: 'resumed', newRunId };
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

  private async resumeRun(parkedRunId: string, answer: string | undefined): Promise<string | undefined> {
    const [parked] = await this.db
      .select({
        workspaceId: schema.runs.workspaceId,
        ticketId: schema.runs.ticketId,
        agentId: schema.runs.agentId,
        attempt: schema.runs.attempt,
        executorType: schema.runs.executorType,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, parkedRunId))
      .limit(1);
    if (!parked) return undefined;

    let newRunId: string | undefined;
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
          agentId: parked.agentId,
          executorType: parked.executorType,
          status: 'queued',
          attempt: parked.attempt + 1,
          triggerEvent: { source: 'human-resume', resolution: answer ?? null },
        })
        .returning({ id: schema.runs.id });
      newRunId = inserted.id;
    });

    if (!newRunId) return undefined;

    // No BullMQ `deduplication` option here (unlike RunTriggerService): the
    // dedup key is tied to the JOB's retained Redis lifetime, not the
    // logical trigger — the original (completed-but-retained,
    // removeOnComplete keeps history) job under the same
    // `${ticketId}:${agentId}` key would silently swallow this add. Not
    // needed anyway: the guarded supersede+insert transaction above already
    // guarantees at most one enqueue per successful resume (Constitution II
    // level 3, DB-authoritative) — a concurrent duplicate resolve() call
    // sees 0 superseded rows and bails before ever reaching this line.
    const queue = this.moduleRef.get<Queue>(getQueueToken(runQueueName(parked.executorType)), { strict: false });
    await queue.add('run', { runId: newRunId }, { jobId: newRunId });

    await this.transitionToRunning(parked.agentId, parked.ticketId, newRunId);

    return newRunId;
  }

  private async transitionToRunning(agentId: string, ticketId: string, newRunId: string): Promise<void> {
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
      await this.jira.transitionTo(ticket.jiraKey, agent.statusRunning);
    } catch (err) {
      this.logger.warn(`resume: running-status transition failed (non-fatal) for run ${newRunId}: ${String(err)}`);
    }
  }
}

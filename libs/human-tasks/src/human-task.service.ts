import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JiraClientFactory, buildHumanTaskComment } from '@brigadir/jira';
import type { HumanTaskKind } from '@brigadir/contracts';

export interface CreateHumanTaskInput {
  kind: HumanTaskKind;
  /** Already scrubbed by the caller (CallbackModule) — this service does no scrubbing. */
  title: string;
  details?: string;
  blocking: boolean;
}

export interface CreateHumanTaskResult {
  /** false when an open task already existed for this run (FR-020 dedup) — no second row inserted. */
  created: boolean;
  blocking: boolean;
  mayFinishWithoutComplete: boolean;
}

/**
 * HumanTaskService (FR-012/014/015/020). Creates a human task from a
 * `request_human` callback, deduped to one open task per run; a blocking
 * request additionally parks the run (`awaiting_human`, guarded — only from
 * `running`) and drives the Jira blocked-status transition + question
 * comment. Non-blocking requests only queue the task; the run keeps running.
 */
@Injectable()
export class HumanTaskService {
  private readonly logger = new Logger(HumanTaskService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    // Per-workspace client (feature 006 checkpoint) — the blocked-status
    // transition/comment must hit the run's own workspace site.
    private readonly jiraFactory: JiraClientFactory,
  ) {}

  async createFromRequest(runId: string, input: CreateHumanTaskInput): Promise<CreateHumanTaskResult> {
    const [run] = await this.db
      .select({
        workspaceId: schema.runs.workspaceId,
        ticketId: schema.runs.ticketId,
        agentId: schema.runs.agentId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) {
      throw new Error(`run ${runId} not found`);
    }

    const existingOpen = await this.db
      .select({ id: schema.humanTasks.id })
      .from(schema.humanTasks)
      .where(and(eq(schema.humanTasks.runId, runId), eq(schema.humanTasks.status, 'open')))
      .limit(1);

    if (existingOpen.length > 0) {
      this.logger.log(`run ${runId} already has an open human task — dedup guard (FR-020), no new row`);
      return { created: false, blocking: input.blocking, mayFinishWithoutComplete: input.blocking };
    }

    await this.db.insert(schema.humanTasks).values({
      workspaceId: run.workspaceId,
      runId,
      ticketId: run.ticketId,
      kind: input.kind,
      title: input.title,
      details: input.details ?? null,
      blocking: input.blocking,
      status: 'open',
    });

    if (!input.blocking) {
      return { created: true, blocking: false, mayFinishWithoutComplete: false };
    }

    const parked = await this.parkRun(runId);
    if (parked) {
      await this.transitionAndComment(run.workspaceId, run.agentId, run.ticketId, input);
    } else {
      this.logger.warn(`run ${runId} was not in "running" when blocking request_human arrived — no park/transition`);
    }

    return { created: true, blocking: true, mayFinishWithoutComplete: true };
  }

  /** Guarded — only parks a run that is currently `running` (never clobbers a race). */
  private async parkRun(runId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.runs)
      .set({ status: 'awaiting_human' })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
      .returning({ id: schema.runs.id });
    return rows.length > 0;
  }

  private async transitionAndComment(
    workspaceId: string,
    agentId: string,
    ticketId: string,
    input: CreateHumanTaskInput,
  ): Promise<void> {
    const [agent] = await this.db
      .select({ statusFailure: schema.agents.statusFailure })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    const [ticket] = await this.db
      .select({ jiraKey: schema.tickets.jiraKey })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);
    if (!agent || !ticket) return;

    // Non-fatal (matches PipelineService.onRunFinished's posture): the run
    // park + human_tasks row are already committed by the time this runs —
    // a Jira hiccup must not turn a successful callback into a 5xx the MCP
    // client would retry (D9), since retrying would just re-attempt an
    // already-satisfied dedup guard. Self-heals on reconcile.
    try {
      const jira = await this.jiraFactory.forWorkspace(workspaceId);
      await jira.transitionTo(ticket.jiraKey, agent.statusFailure);
      await jira.addComment(ticket.jiraKey, buildHumanTaskComment(input));
    } catch (err) {
      this.logger.warn(`blocked-status transition/comment failed (non-fatal): ${String(err)}`);
    }
  }
}

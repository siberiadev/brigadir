import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JiraClientFactory, buildHumanTaskComment } from '@brigadir/jira';
import type { HumanTaskKind, AnswerOption } from '@brigadir/contracts';

export interface CreateHumanTaskInput {
  kind: HumanTaskKind;
  /** Already scrubbed by the caller (CallbackModule) — this service does no scrubbing. */
  title: string;
  details?: string;
  blocking: boolean;
  /**
   * Suggested answer options (feature 013), already scrubbed by the caller like
   * title/details. System-composed tasks (triage-limit, orchestrator failure,
   * PR review, team review) never pass them — the column stays NULL.
   */
  options?: AnswerOption[];
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

  /**
   * Non-blocking human task from a pipeline fallback (feature 010, FR-005/009/
   * 010) — the triage-limit, routing-override, and orchestrator-failure paths.
   * Delegates to {@link createFromRequest} with `blocking=false`: it queues the
   * task (deduped to one open task per run) and never parks the run or moves the
   * ticket (the ticket already sits in its failure status). `title`/`details`
   * must already be scrubbed by the caller (system-composed here, or read back
   * from an already-scrubbed report field).
   */
  async createNonBlocking(
    runId: string,
    input: { kind: HumanTaskKind; title: string; details?: string },
  ): Promise<CreateHumanTaskResult> {
    return this.createFromRequest(runId, { ...input, blocking: false });
  }

  /**
   * Feature 022 (FR-010, research R5): run-less blocked-ticket task — a
   * trigger-status ticket waits on a blocker outside the observed board scope,
   * a condition the system can never resolve itself. No run exists (that is the
   * point), so nothing is parked and no Jira write happens; the ticket stays in
   * its trigger status. Dedup: at most one OPEN run-less task per ticket —
   * repeated release passes are no-ops while the condition persists. If a human
   * resolves the task without fixing the board, a later pass re-creates it
   * (the condition genuinely still holds).
   */
  async createTicketBlocked(
    workspaceId: string,
    ticketId: string,
    input: { title: string; details?: string },
  ): Promise<{ created: boolean }> {
    const existingOpen = await this.db
      .select({ id: schema.humanTasks.id })
      .from(schema.humanTasks)
      .where(
        and(
          eq(schema.humanTasks.ticketId, ticketId),
          isNull(schema.humanTasks.runId),
          eq(schema.humanTasks.status, 'open'),
        ),
      )
      .limit(1);
    if (existingOpen.length > 0) return { created: false };

    await this.db.insert(schema.humanTasks).values({
      workspaceId,
      runId: null,
      ticketId,
      kind: 'blocker',
      title: input.title,
      details: input.details ?? null,
      blocking: false,
      status: 'open',
    });
    return { created: true };
  }

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
      options: input.options ?? null,
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
    ticketId: string | null,
    input: CreateHumanTaskInput,
  ): Promise<void> {
    // Ticketless workspace-setup runs (feature 011): there is no Jira side to
    // drive — the park + human_tasks row above are the whole effect.
    if (ticketId === null) return;
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

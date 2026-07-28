import { Injectable, Inject, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { runQueueName } from '@brigadir/queues';
import type { TriggerEvent } from '@brigadir/contracts';

export interface TriggerInput {
  // Null for ticketless workspace-setup runs (feature 011, D2) — the
  // `runs_one_active_setup` partial index guards those per workspace.
  ticketId: string | null;
  agentId: string;
  triggerEvent?: TriggerEvent;
}

export type TriggerResult =
  | { deduplicated: false; runId: string }
  | { deduplicated: true; existingRunId: string | undefined };

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_human'];

/**
 * Continuation sources (feature 010) — a triage or rework run is a fresh
 * follow-up on a ticket the agent may already have a RETAINED completed job for
 * (`removeOnComplete` keeps history). BullMQ `deduplication` keyed on
 * `${ticketId}:${agentId}` would silently swallow the re-enqueue against that
 * retained job (the same hazard `ResumeService` documents), leaving the new run
 * row stuck in `queued`. For these the `runs_one_active` partial unique index
 * (idempotency level 3) is the authority, so the BullMQ dedup layer is dropped.
 */
const CONTINUATION_SOURCES = new Set(['triage', 'rework', 'human-resume', 'answer-triage']);

/**
 * Sources that skip the BullMQ dedup layer entirely. `workspace-setup` joins
 * the continuation set (feature 011, D1): its dedup id would be built from a
 * NULL ticket, and a retained completed setup job must not swallow a later
 * legitimate regeneration — `runs_one_active_setup` (level 3) is the authority.
 */
const QUEUE_DEDUP_SKIP_SOURCES = new Set([...CONTINUATION_SOURCES, 'workspace-setup']);

/**
 * RunTriggerService (contracts C6) — the single enqueue seam.
 *
 * 1. INSERT a `runs` row (status `queued`, attempt 1). The `runs_one_active`
 *    partial unique index (idempotency level 3) makes a duplicate active run for
 *    the same (ticket, agent) raise 23505 → we return `{ deduplicated: true }`.
 * 2. Enqueue `run` with BullMQ deduplication (level 2), the agent's attempt
 *    budget, and the custom backoff.
 */
@Injectable()
export class RunTriggerService {
  private readonly logger = new Logger(RunTriggerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly moduleRef: ModuleRef,
  ) {}

  async trigger({ ticketId, agentId, triggerEvent }: TriggerInput): Promise<TriggerResult> {
    const [agent] = await this.db
      .select({
        id: schema.agents.id,
        workspaceId: schema.agents.workspaceId,
        executorId: schema.agents.executorId,
        maxAttempts: schema.agents.maxAttempts,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    if (!agent) {
      throw new Error(`agent ${agentId} not found`);
    }

    const [executor] = await this.db
      .select({ type: schema.executors.type })
      .from(schema.executors)
      .where(eq(schema.executors.id, agent.executorId))
      .limit(1);
    if (!executor) {
      throw new Error(`executor ${agent.executorId} not found`);
    }
    const executorType = executor.type;

    let runId: string;
    try {
      const [row] = await this.db
        .insert(schema.runs)
        .values({
          workspaceId: agent.workspaceId,
          ticketId,
          agentId,
          executorType,
          status: 'queued',
          attempt: 1,
          triggerEvent: triggerEvent ?? { source: 'manual' },
        })
        .returning({ id: schema.runs.id });
      runId = row.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // 23505 comes from `runs_one_active` (ticketed) or `runs_one_active_setup`
        // (ticketless, per-workspace) — the lookup mirrors whichever guard fired.
        // `runs_one_active` is per-TICKET since SXF-1174 Problem 6 (migration
        // 0011): the holder may belong to a DIFFERENT agent.
        const [existing] = await this.db
          .select({ id: schema.runs.id })
          .from(schema.runs)
          .where(
            and(
              ticketId === null
                ? and(eq(schema.runs.workspaceId, agent.workspaceId), isNull(schema.runs.ticketId))
                : eq(schema.runs.ticketId, ticketId),
              inArray(schema.runs.status, ACTIVE_STATUSES),
            ),
          )
          .limit(1);
        this.logger.log(
          `trigger deduplicated (ticket ${ticketId ?? 'none'}, agent ${agentId}) → existing run ${existing?.id ?? '?'}`,
        );
        return { deduplicated: true, existingRunId: existing?.id };
      }
      throw err;
    }

    const skipQueueDedup = QUEUE_DEDUP_SKIP_SOURCES.has(triggerEvent?.source ?? 'manual');
    const queue = this.getRunQueue(executorType);
    await queue.add(
      'run',
      { runId },
      {
        // jobId pinned to the run id (feature 004): lets CallbackModule
        // resolve the exact BullMQ Job for job.updateProgress() from the
        // backend process without a new DB column.
        jobId: runId,
        // Triage/rework/resume continuations and workspace-setup skip the BullMQ
        // dedup layer to avoid the retained-job swallow (QUEUE_DEDUP_SKIP_SOURCES);
        // the DB partial unique guards already made this enqueue exactly-once.
        // Deliberately NOT widened to per-ticket alongside runs_one_active
        // (SXF-1174 Problem 6): level 2 only guards duplicate enqueues and runs
        // strictly after a successful insert — a per-ticket id would let agent
        // A's retained completed job swallow agent B's later legitimate enqueue.
        ...(skipQueueDedup ? {} : { deduplication: { id: `${ticketId}:${agentId}` } }),
        attempts: agent.maxAttempts,
        backoff: { type: 'custom' },
      },
    );

    return { deduplicated: false, runId };
  }

  private getRunQueue(executorType: string): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(runQueueName(executorType)), { strict: false });
  }
}

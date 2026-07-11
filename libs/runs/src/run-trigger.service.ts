import { Injectable, Inject, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { runQueueName } from '@brigadir/queues';
import type { TriggerEvent } from '@brigadir/contracts';

export interface TriggerInput {
  ticketId: string;
  agentId: string;
  triggerEvent?: TriggerEvent;
}

export type TriggerResult =
  | { deduplicated: false; runId: string }
  | { deduplicated: true; existingRunId: string | undefined };

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_human'];

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
        const [existing] = await this.db
          .select({ id: schema.runs.id })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.ticketId, ticketId),
              eq(schema.runs.agentId, agentId),
              inArray(schema.runs.status, ACTIVE_STATUSES),
            ),
          )
          .limit(1);
        this.logger.log(
          `trigger deduplicated (ticket ${ticketId}, agent ${agentId}) → existing run ${existing?.id ?? '?'}`,
        );
        return { deduplicated: true, existingRunId: existing?.id };
      }
      throw err;
    }

    const queue = this.getRunQueue(executorType);
    await queue.add(
      'run',
      { runId },
      {
        deduplication: { id: `${ticketId}:${agentId}` },
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

import type { Logger } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';

/**
 * Wire `executors.concurrency_limit` to the live BullMQ worker (checkpoint fix,
 * 2026-07-12): the @Processor decorator's `concurrency` is evaluated at
 * composition time and CANNOT read the DB (CLAUDE.md rule #1), so it stays a
 * static fallback and the real limit is applied here at bootstrap, when the
 * worker instance exists. Several executors of one type (e.g. a subscription
 * runner + a team API-key runner) share the type's queue, so the worker's slot
 * count is their SUM. No rows → the decorator default stands.
 *
 * Boot-time only for now: editing the limit requires a worker restart until
 * iteration 6's executors CRUD adds live re-apply.
 */
export async function applyExecutorConcurrency(
  db: BrigadirDb,
  worker: Worker,
  executorType: string,
  logger: Logger,
): Promise<void> {
  const [row] = await db
    .select({ total: sql<number>`sum(${schema.executors.concurrencyLimit})::int` })
    .from(schema.executors)
    .where(eq(schema.executors.type, executorType));

  const total = row?.total;
  if (typeof total === 'number' && total > 0) {
    const before = worker.concurrency;
    worker.concurrency = total;
    logger.log(
      `run.${executorType} concurrency: ${total} (from executors.concurrency_limit; decorator default was ${before})`,
    );
  }
}

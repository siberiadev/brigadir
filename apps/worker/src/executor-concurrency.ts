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
 * Called at bootstrap AND on a periodic timer (feature 006, FR-025): editing a
 * limit re-applies to the live worker within ~15 s with no restart. The DB is
 * read live on each call (constitution lazy-resolution). A no-op tick (the sum
 * is unchanged) neither reassigns nor logs, so the timer stays quiet.
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
    if (total === before) return; // unchanged → quiet no-op
    worker.concurrency = total;
    logger.log(
      `run.${executorType} concurrency: ${total} (from executors.concurrency_limit; was ${before})`,
    );
  }
}

/** Default live re-apply cadence (feature 006, FR-025: ≤ ~15 s lag). */
const DEFAULT_REAPPLY_MS = 15_000;

/**
 * Start the periodic concurrency re-apply timer. Returns the interval handle so
 * the processor clears it on module destroy (no leak in tests / clean shutdown).
 * `unref()` so the timer never keeps the process alive on its own. Cadence is
 * overridable via `EXECUTOR_CONCURRENCY_REAPPLY_MS` (read at call time — runtime,
 * not composition).
 */
export function startConcurrencyReapply(
  db: BrigadirDb,
  worker: Worker,
  executorType: string,
  logger: Logger,
): NodeJS.Timeout {
  const everyMs = Number(process.env.EXECUTOR_CONCURRENCY_REAPPLY_MS ?? DEFAULT_REAPPLY_MS);
  const timer = setInterval(() => {
    void applyExecutorConcurrency(db, worker, executorType, logger).catch((err) => {
      // Best-effort: a transient DB error must not crash the worker.
      logger.error(`concurrency re-apply (${executorType}) failed: ${String(err)}`);
    });
  }, everyMs);
  timer.unref?.();
  return timer;
}

import type { Logger } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';

/**
 * TYPE CAPACITY: wire the sum of ENABLED profiles' `max_parallel_runs` to the
 * live BullMQ worker (checkpoint fix 2026-07-12; named runner profiles
 * 2026-07-14). The @Processor decorator's `concurrency` is evaluated at
 * composition time and CANNOT read the DB (CLAUDE.md rule #1), so it stays a
 * static fallback and the real limit is applied here at bootstrap, when the
 * worker instance exists. Several profiles of one type (e.g. a subscription
 * runner + a team API-key runner) share the type's queue, so the worker's slot
 * count is their SUM — the platform-wide ceiling for the type. The PER-PROFILE
 * cap is enforced separately by the processor-side gate (executor-gate.ts),
 * which counts running runs per executor_id before executing a job. A
 * disabled profile contributes NO capacity (its jobs are held by the gate).
 * No enabled rows → the decorator default stands.
 *
 * Called at bootstrap AND on a periodic timer (feature 006, FR-025): editing a
 * limit re-applies to the live worker within ~15 s with no restart. The DB is
 * read live on each call (constitution lazy-resolution). A no-op tick (the sum
 * is unchanged) neither reassigns nor logs, so the timer stays quiet.
 *
 * OPERATOR CEILING (incident 2026-07-19 Phase 5, Problem 7): the incident's
 * profiles summed to a type capacity of 22 on one host. The sum is now clamped
 * to an optional ceiling — `EXECUTOR_MAX_TYPE_CONCURRENCY_<TYPE>` (uppercased,
 * e.g. `..._CLAUDE_CLI`) wins over the generic `EXECUTOR_MAX_TYPE_CONCURRENCY`
 * — read lazily at call time (CLAUDE.md rule #1). Unset ⇒ pure sum, exactly
 * the pre-Phase-5 behavior; a value that is not an integer ≥ 1 is ignored.
 */

/** Lazy ceiling lookup; `source` feeds the log line when the clamp bites. */
function typeCapacityCeiling(
  executorType: string,
): { value: number; source: string } | undefined {
  const names = [
    `EXECUTOR_MAX_TYPE_CONCURRENCY_${executorType.toUpperCase()}`,
    'EXECUTOR_MAX_TYPE_CONCURRENCY',
  ];
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1) return { value, source: `${name}=${value}` };
  }
  return undefined;
}

export async function applyExecutorConcurrency(
  db: BrigadirDb,
  worker: Worker,
  executorType: string,
  logger: Logger,
): Promise<void> {
  const [row] = await db
    .select({ total: sql<number>`sum(${schema.executors.maxParallelRuns})::int` })
    .from(schema.executors)
    .where(and(eq(schema.executors.type, executorType), eq(schema.executors.enabled, true)));

  const total = row?.total;
  if (typeof total === 'number' && total > 0) {
    const ceiling = typeCapacityCeiling(executorType);
    const effective = ceiling !== undefined ? Math.min(total, ceiling.value) : total;
    const before = worker.concurrency;
    if (effective === before) return; // unchanged → quiet no-op
    worker.concurrency = effective;
    logger.log(
      ceiling !== undefined && effective < total
        ? `run.${executorType} type capacity: ${effective} (sum ${total} clamped by ${ceiling.source}; was ${before})`
        : `run.${executorType} type capacity: ${effective} (sum of enabled profiles' max_parallel_runs; was ${before})`,
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

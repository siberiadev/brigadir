import { and, eq, sql } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';

/**
 * Per-profile parallelism gate (named runner profiles, 2026-07-14). The
 * worker's own concurrency is the TYPE capacity (sum of enabled profiles —
 * executor-concurrency.ts); this gate is what makes each profile's
 * `max_parallel_runs` a real cap: before executing a job the processor counts
 * runs currently `running` on the job's profile (resolved via the run's agent
 * — runs carry executor_type, not executor_id) and, at/over the limit or when
 * the profile is disabled, returns the job to waiting WITHOUT consuming an
 * attempt via the established rate-limit path (`worker.rateLimit(ttl)` +
 * `Worker.RateLimitError()`).
 *
 * Known tradeoffs of reusing that path (accepted by design decision):
 * `worker.rateLimit` pauses the WHOLE type queue for the ttl, so a saturated
 * or disabled profile briefly stalls its type's other profiles — the ttls are
 * kept short to bound it. The count-then-run check is not transactional with
 * markRunning; concurrent pickups can transiently over-admit by the number of
 * in-flight slots, bounded by the type capacity.
 */

/** Saturated profile: a slot frees when a run finishes — re-check quickly. */
const AT_CAPACITY_TTL_MS = 1000;
/** Disabled profile: only an operator edit frees it — back off harder. */
const DISABLED_TTL_MS = 15_000;

export type GateVerdict =
  | { admit: true }
  | { admit: false; reason: 'at_capacity' | 'disabled'; ttlMs: number; profile: string };

/** Read the gate ttl override lazily (tests) — runtime read, never composition. */
function ttlOverride(): number | undefined {
  const raw = process.env.EXECUTOR_GATE_TTL_MS;
  return raw ? Number(raw) : undefined;
}

export async function checkExecutorGate(db: BrigadirDb, runId: string): Promise<GateVerdict> {
  const [profile] = await db
    .select({
      executorId: schema.executors.id,
      name: schema.executors.name,
      maxParallelRuns: schema.executors.maxParallelRuns,
      enabled: schema.executors.enabled,
    })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
    .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
    .where(eq(schema.runs.id, runId))
    .limit(1);

  // Missing run/agent/profile → admit; the processor's own load() owns that
  // failure mode (drop with a warning), not the gate.
  if (!profile) return { admit: true };

  if (!profile.enabled) {
    return {
      admit: false,
      reason: 'disabled',
      ttlMs: ttlOverride() ?? DISABLED_TTL_MS,
      profile: profile.name,
    };
  }

  const [running] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
    .where(and(eq(schema.agents.executorId, profile.executorId), eq(schema.runs.status, 'running')));

  if ((running?.count ?? 0) >= profile.maxParallelRuns) {
    return {
      admit: false,
      reason: 'at_capacity',
      ttlMs: ttlOverride() ?? AT_CAPACITY_TTL_MS,
      profile: profile.name,
    };
  }
  return { admit: true };
}

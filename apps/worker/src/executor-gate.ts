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
 * PER-MODEL cap (incident 2026-07-19 Phase 5, Problem 7): profiles carry their
 * model in `config.model`; `EXECUTOR_MODEL_LIMITS` (JSON map model → positive
 * integer, read lazily per call — CLAUDE.md rule #1) caps the `running` runs
 * across ALL profiles sharing that model, regardless of executor type, so an
 * expensive model cannot occupy the whole type capacity. A model absent from
 * the map has no model cap. Admit verdicts additionally carry a `nearCapacity`
 * hint when post-admit occupancy of the tightest applicable limit reaches 75%
 * — the processor turns it into an operator-visible warn (DB access lives
 * here, logging in the processor).
 *
 * Known tradeoffs of reusing the rate-limit path (accepted by design
 * decision): `worker.rateLimit` pauses the WHOLE type queue for the ttl, so a
 * saturated or disabled profile briefly stalls its type's other profiles — the
 * ttls are kept short to bound it. The count-then-run check (per-profile AND
 * per-model) is not transactional with markRunning; concurrent pickups can
 * transiently over-admit by the number of in-flight slots, bounded by the type
 * capacity.
 */

/** Saturated profile: a slot frees when a run finishes — re-check quickly. */
const AT_CAPACITY_TTL_MS = 1000;
/** Disabled profile: only an operator edit frees it — back off harder. */
const DISABLED_TTL_MS = 15_000;
/** Saturated model: same reasoning as a saturated profile — a slot frees when
 * any run on that model finishes, so re-check quickly. */
const MODEL_AT_CAPACITY_TTL_MS = 1000;

/** Post-admit occupancy at/over this fraction of a limit triggers the hint. */
const NEAR_CAPACITY_FRACTION = 0.75;

export interface NearCapacity {
  limitKind: 'profile' | 'model';
  /** Running count INCLUDING the run being admitted. */
  running: number;
  limit: number;
}

export type GateVerdict =
  | { admit: true; nearCapacity?: NearCapacity }
  | {
      admit: false;
      reason: 'at_capacity' | 'disabled' | 'model_at_capacity';
      ttlMs: number;
      profile: string;
      model?: string;
    };

/** Minimal logging surface so the gate stays dependency-free; the processor
 * passes its Nest Logger. Only used for operator-input problems. */
export interface GateLogger {
  warn(message: string): void;
}

/** Read the gate ttl override lazily (tests) — runtime read, never composition. */
function ttlOverride(): number | undefined {
  const raw = process.env.EXECUTOR_GATE_TTL_MS;
  return raw ? Number(raw) : undefined;
}

/** One warn per DISTINCT raw value: the gate re-runs every ~1s at capacity, so
 * a malformed `EXECUTOR_MODEL_LIMITS` must not flood the log. */
let lastWarnedModelLimitsRaw: string | undefined;

function warnOnce(raw: string, message: string, logger?: GateLogger): void {
  if (lastWarnedModelLimitsRaw === raw) return;
  lastWarnedModelLimitsRaw = raw;
  logger?.warn(message);
}

/**
 * Parse `EXECUTOR_MODEL_LIMITS` (`'{"claude-opus-4-8":2}'`) into a validated
 * model → limit map. Malformed JSON or a non-object yields an EMPTY map (no
 * cap — same as unset) and non-positive/non-integer entries are dropped; both
 * are warned once per distinct raw value so an operator typo is visible
 * without disabling admission.
 */
export function parseModelLimits(
  raw: string | undefined,
  logger?: GateLogger,
): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(raw, `EXECUTOR_MODEL_LIMITS is not valid JSON — no model caps applied: ${raw}`, logger);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnOnce(raw, `EXECUTOR_MODEL_LIMITS must be a JSON object — no model caps applied: ${raw}`, logger);
    return {};
  }
  const limits: Record<string, number> = {};
  for (const [model, limit] of Object.entries(parsed)) {
    if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) {
      limits[model] = limit;
    } else {
      warnOnce(
        raw,
        `EXECUTOR_MODEL_LIMITS entry "${model}" is not a positive integer — entry dropped: ${raw}`,
        logger,
      );
    }
  }
  return limits;
}

/** Pure decision inputs: counts + limits gathered by `checkExecutorGate`. */
export interface GateInputs {
  profileName: string;
  enabled: boolean;
  maxParallelRuns: number;
  profileRunning: number;
  /** The profile's `config.model`; undefined when the profile has none. */
  model?: string;
  /** Configured cap for `model`; undefined ⇒ no per-model dimension. */
  modelLimit?: number;
  /** `running` count across all profiles sharing `model` (any type). */
  modelRunning?: number;
  ttlOverride?: number;
}

/**
 * Pure verdict: disabled → per-profile → per-model, then the `nearCapacity`
 * hint on admit. Split from the DB shell so the decision surface unit-tests
 * without Docker.
 */
export function decideGate(i: GateInputs): GateVerdict {
  if (!i.enabled) {
    return {
      admit: false,
      reason: 'disabled',
      ttlMs: i.ttlOverride ?? DISABLED_TTL_MS,
      profile: i.profileName,
    };
  }

  if (i.profileRunning >= i.maxParallelRuns) {
    return {
      admit: false,
      reason: 'at_capacity',
      ttlMs: i.ttlOverride ?? AT_CAPACITY_TTL_MS,
      profile: i.profileName,
    };
  }

  const modelCapped = i.model !== undefined && i.modelLimit !== undefined;
  if (modelCapped && (i.modelRunning ?? 0) >= (i.modelLimit as number)) {
    return {
      admit: false,
      reason: 'model_at_capacity',
      ttlMs: i.ttlOverride ?? MODEL_AT_CAPACITY_TTL_MS,
      profile: i.profileName,
      model: i.model,
    };
  }

  // Post-admit occupancy per applicable dimension; the tightest (highest
  // utilization) wins. Post-admit — not the pre-admit count — because with the
  // default max_parallel_runs=2 a pre-admit reading could never reach 75%.
  const dimensions: NearCapacity[] = [
    { limitKind: 'profile', running: i.profileRunning + 1, limit: i.maxParallelRuns },
  ];
  if (modelCapped) {
    dimensions.push({
      limitKind: 'model',
      running: (i.modelRunning ?? 0) + 1,
      limit: i.modelLimit as number,
    });
  }
  const tightest = dimensions.reduce((a, b) =>
    b.running / b.limit > a.running / a.limit ? b : a,
  );
  if (tightest.running / tightest.limit >= NEAR_CAPACITY_FRACTION) {
    return { admit: true, nearCapacity: tightest };
  }
  return { admit: true };
}

export async function checkExecutorGate(
  db: BrigadirDb,
  runId: string,
  logger?: GateLogger,
): Promise<GateVerdict> {
  const [profile] = await db
    .select({
      executorId: schema.executors.id,
      name: schema.executors.name,
      maxParallelRuns: schema.executors.maxParallelRuns,
      enabled: schema.executors.enabled,
      config: schema.executors.config,
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
    return decideGate({
      profileName: profile.name,
      enabled: false,
      maxParallelRuns: profile.maxParallelRuns,
      profileRunning: 0,
      ttlOverride: ttlOverride(),
    });
  }

  const [running] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
    .where(and(eq(schema.agents.executorId, profile.executorId), eq(schema.runs.status, 'running')));

  const rawModel = (profile.config as { model?: unknown } | null)?.model;
  const model = typeof rawModel === 'string' ? rawModel : undefined;
  const modelLimit =
    model !== undefined
      ? parseModelLimits(process.env.EXECUTOR_MODEL_LIMITS, logger)[model]
      : undefined;

  // Counted only when the model actually has a cap — the common uncapped case
  // pays no extra query.
  let modelRunning: number | undefined;
  if (model !== undefined && modelLimit !== undefined) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
      .where(
        and(
          sql`${schema.executors.config}->>'model' = ${model}`,
          eq(schema.runs.status, 'running'),
        ),
      );
    modelRunning = row?.count ?? 0;
  }

  return decideGate({
    profileName: profile.name,
    enabled: true,
    maxParallelRuns: profile.maxParallelRuns,
    profileRunning: running?.count ?? 0,
    model,
    modelLimit,
    modelRunning,
    ttlOverride: ttlOverride(),
  });
}

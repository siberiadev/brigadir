import { z } from 'zod';
import { RunCostPeriodSchema } from './runs.schema';

/**
 * Metrics API contracts (feature 029, contracts/metrics-api.md) — five read-only
 * timeline endpoints behind the shared DashboardTokenGuard. Single typed source
 * consumed by the backend `metrics.controller` and the Vue composables.
 * `snake_case` bodies; money serialized as a STRING (numeric round-trip), never
 * a float.
 *
 * Every chart is a pre-aggregated time series (FR-013): the response size is
 * bounded by `period × granularity`, never by the number of runs. Timezone of
 * all bucketing is UTC (Assumption); buckets are dense (zero-filled, FR-005).
 */

// --- shared query filters (all 5 endpoints) ---

/**
 * Common filters. `period` tolerates garbage → `7d` (`.catch`, the cost-endpoint
 * convention). `workspace_id`/`executor_type` are optional (absent ⇒ all).
 * `executor_type` is validated softly (min-length string) and is IGNORED by the
 * `/human` endpoint and the `open_human_tasks` overview card (H1/FR-011a) —
 * `human_tasks` carries no executor type.
 */
export const MetricsFilterQuerySchema = z
  .object({
    period: RunCostPeriodSchema.catch('7d').default('7d'),
    workspace_id: z.string().uuid().optional(),
    executor_type: z.string().min(1).optional(),
  })
  .strict();
export type MetricsFilterQuery = z.infer<typeof MetricsFilterQuerySchema>;

/** Bucket width — `hour` only for the 24h period, `day` otherwise (R2). */
export const MetricsGranularitySchema = z.enum(['hour', 'day']);
export type MetricsGranularity = z.infer<typeof MetricsGranularitySchema>;

/**
 * One categorical series of a time-bucketed chart. `points` are numbers for
 * counts/rates/durations and STRINGS for money (numeric round-trip). Length
 * always equals the ambient `buckets.length` (invariant, checked by tests).
 */
export const MetricsSeriesSchema = z
  .object({
    key: z.string(),
    label: z.string().optional(),
    points: z.array(z.union([z.number(), z.string()])),
  })
  .strict();
export type MetricsSeries = z.infer<typeof MetricsSeriesSchema>;

/**
 * The shape of every timeline in this feature (R5). `buckets` is the dense,
 * strictly-increasing ISO grid (zero-filled across the whole period); each
 * series carries one point per bucket.
 */
export const TimeBucketedSeriesSchema = z
  .object({
    granularity: MetricsGranularitySchema,
    buckets: z.array(z.string()),
    series: z.array(MetricsSeriesSchema),
  })
  .strict();
export type TimeBucketedSeries = z.infer<typeof TimeBucketedSeriesSchema>;

// --- GET /api/metrics/overview (US1) — summary scalars, NOT series ---

/** Every run status always present (0 default) so the card never has holes. */
export const RunCountByStatusSchema = z
  .object({
    queued: z.number().int(),
    running: z.number().int(),
    awaiting_human: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
    timed_out: z.number().int(),
    superseded: z.number().int(),
  })
  .strict();
export type RunCountByStatus = z.infer<typeof RunCountByStatusSchema>;

export const MetricsOverviewResponseSchema = z
  .object({
    period: RunCostPeriodSchema,
    // coalesce(sum(cost_usd),0)::text — money as string, "0" when none.
    total_cost_usd: z.string(),
    run_count_by_status: RunCountByStatusSchema,
    // succeeded / (succeeded+failed+timed_out+cancelled); 0..1 rendered as %
    // (L2). null when the denominator is 0.
    success_rate: z.number().nullable(),
    // percentile_cont(0.5) over finished runs only; null when none finished.
    median_duration_s: z.number().nullable(),
    // human_tasks.status='open'; filtered by period+workspace_id, NOT
    // executor_type (H1/FR-011a).
    open_human_tasks: z.number().int(),
  })
  .strict();
export type MetricsOverviewResponse = z.infer<typeof MetricsOverviewResponseSchema>;

// --- GET /api/metrics/cost (US2) ---

/** One workspace's spend for the period bar (top-10, M7). Money as string. */
export const TopWorkspaceCostSchema = z
  .object({
    workspace_id: z.string(),
    name: z.string(),
    total_cost_usd: z.string(),
  })
  .strict();
export type TopWorkspaceCost = z.infer<typeof TopWorkspaceCostSchema>;

export const MetricsCostResponseSchema = z
  .object({
    // Spend stacked by executor_type; points are money strings.
    cost_by_executor: TimeBucketedSeriesSchema,
    // Four series: input | output | cache_read | cache_creation; points numeric.
    tokens_by_type: TimeBucketedSeriesSchema,
    // One series key='cost_per_run'; points money strings.
    cost_per_run: TimeBucketedSeriesSchema,
    // Top-10 by spend; present ONLY when workspace_id is unset, else [] (US2 AS3).
    top_workspaces_by_cost: z.array(TopWorkspaceCostSchema),
  })
  .strict();
export type MetricsCostResponse = z.infer<typeof MetricsCostResponseSchema>;

// --- GET /api/metrics/reliability (US3) ---

export const MetricsReliabilityResponseSchema = z
  .object({
    // Count per status (stacked area); points numeric.
    runs_by_status: TimeBucketedSeriesSchema,
    // One series key='success_rate'; points 0..1.
    success_rate: TimeBucketedSeriesSchema,
    // Two series (seconds), anchored on finished_at (FR-005a/M2).
    duration_median_s: TimeBucketedSeriesSchema,
    duration_p95_s: TimeBucketedSeriesSchema,
    // One series key='retry_rate'; points 0..1.
    retry_rate: TimeBucketedSeriesSchema,
    // failed+timed_out count per executor_type; points numeric.
    failstats_by_executor: TimeBucketedSeriesSchema,
  })
  .strict();
export type MetricsReliabilityResponse = z.infer<typeof MetricsReliabilityResponseSchema>;

// --- GET /api/metrics/activity (US4) ---

export const MetricsActivityResponseSchema = z
  .object({
    // Run count by trigger source (+ '__unknown__' when NULL).
    by_source: TimeBucketedSeriesSchema,
    // Run count by agent role (+ '__unknown__' when NULL).
    by_role: TimeBucketedSeriesSchema,
    // Run count by workspace; each series carries the workspace name as label.
    by_workspace: TimeBucketedSeriesSchema,
  })
  .strict();
export type MetricsActivityResponse = z.infer<typeof MetricsActivityResponseSchema>;

// --- GET /api/metrics/human (US5) ---
// Filters: period + workspace_id only. executor_type is ignored (H1/FR-011a).

export const MetricsHumanResponseSchema = z
  .object({
    // Resolution latency (seconds), anchored on resolved_at; resolved tasks only.
    latency_median_s: TimeBucketedSeriesSchema,
    latency_p95_s: TimeBucketedSeriesSchema,
    // Opened per kind (anchor created_at) / closed per kind (anchor resolved_at).
    opened_by_kind: TimeBucketedSeriesSchema,
    closed_by_kind: TimeBucketedSeriesSchema,
    // Share of runs currently status='awaiting_human' per bucket; points 0..1.
    awaiting_human_share: TimeBucketedSeriesSchema,
  })
  .strict();
export type MetricsHumanResponse = z.infer<typeof MetricsHumanResponseSchema>;

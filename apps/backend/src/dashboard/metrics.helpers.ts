import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  MetricsFilterQuerySchema,
  type MetricsGranularity,
  type MetricsSeries,
} from '@brigadir/contracts';

/**
 * Shared aggregation helpers for the metrics timeline endpoints (feature 029).
 * This is the first `date_trunc`/`generate_series`/pivot code in the codebase,
 * so the bucketing rules live in one place:
 *
 * - **Granularity** (R2): `24h → hour`, else `day`.
 * - **Timezone** (M4/R3): bucket truncation is ALWAYS explicit UTC —
 *   `date_trunc(gran, ts, 'UTC')` — never relying on the session TimeZone. The
 *   dense JS grid is likewise computed on UTC hour/day boundaries so its ISO
 *   strings match the SQL bucket keys exactly (both are epoch-ms derived).
 * - **Zero-fill** (R3/FR-005): the grid is dense; missing (bucket, key) cells
 *   fill with `0` (or the string `"0"` for money).
 * - **Filters** (H1): `period`+`workspace_id` apply everywhere; `executor_type`
 *   applies to runs-derived metrics only — the human-task queries never take it.
 */

export const PERIOD_HOURS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface MetricsFilters {
  period: '24h' | '7d' | '30d';
  granularity: MetricsGranularity;
  hours: number;
  /** Valid uuid to scope to, or null for all workspaces. */
  workspaceId: string | null;
  /** Executor type to scope runs-derived metrics to, or null for all. */
  executorType: string | null;
  /**
   * A workspace_id was supplied but is NOT a valid uuid (M8): the controller
   * must return 200 with a dense-but-empty grid rather than 4xx. When true,
   * skip the DB read entirely and pivot over zero rows.
   */
  matchNothing: boolean;
}

/**
 * Parse the shared query params softly (never 4xx). `period` tolerates garbage
 * → `7d`. An absent workspace_id ⇒ all; a present-but-invalid one ⇒
 * `matchNothing` (empty result, M8). `executor_type` is a soft optional string.
 */
export function parseMetricsFilters(query: {
  period?: string;
  workspace_id?: string;
  executor_type?: string;
}): MetricsFilters {
  const period = MetricsFilterQuerySchema.shape.period.parse(query.period);

  let workspaceId: string | null = null;
  let matchNothing = false;
  if (query.workspace_id !== undefined && query.workspace_id !== '') {
    const parsed = MetricsFilterQuerySchema.shape.workspace_id.safeParse(query.workspace_id);
    if (parsed.success && parsed.data) workspaceId = parsed.data;
    else matchNothing = true; // supplied but not a uuid → empty, not an error
  }

  const executorType =
    query.executor_type !== undefined && query.executor_type !== ''
      ? query.executor_type
      : null;

  return {
    period,
    granularity: period === '24h' ? 'hour' : 'day',
    hours: PERIOD_HOURS[period],
    workspaceId,
    executorType,
    matchNothing,
  };
}

/**
 * `date_trunc(gran, column, 'UTC')` re-expressed as epoch milliseconds
 * (`::float8` so node-postgres yields a JS number, not a numeric string). The
 * ms key matches the dense JS grid produced by {@link generateBuckets}.
 *
 * The granularity is inlined as a SQL literal (not a bound parameter) so the
 * expression is TEXTUALLY identical in SELECT and GROUP BY — Postgres matches
 * grouped expressions by parse tree, and two identical `date_trunc` calls with
 * DIFFERENT `$n` placeholders would be treated as distinct (a "must appear in
 * GROUP BY" error). Safe because granularity is a validated 'hour'|'day' enum,
 * never user input.
 */
export function bucketMsExpr(granularity: MetricsGranularity, column: PgColumn): SQL<number> {
  const field = granularity === 'hour' ? 'hour' : 'day';
  return sql<number>`(extract(epoch from date_trunc(${sql.raw(`'${field}'`)}, ${column}, 'UTC')) * 1000)::float8`;
}

/**
 * Period window on an anchor column: `anchor >= now() - hours`. Runs/activity
 * anchor on `created_at`; the duration series and human latency/close series
 * anchor on `finished_at`/`resolved_at` (FR-005a/M2) — the caller passes the
 * right column.
 */
export function windowExpr(anchor: PgColumn, hours: number): SQL {
  return sql`${anchor} >= now() - (${hours} * interval '1 hour')`;
}

/**
 * Build the WHERE for a runs-derived metric: the period window on `anchor`
 * plus the optional workspace and executor filters. `matchNothing` collapses
 * to `false` (invalid workspace uuid, M8). Pass `includeExecutor: false` for
 * the `open_human_tasks`/human paths where executor_type is not applicable.
 */
export function runsWhere(
  filters: MetricsFilters,
  anchor: PgColumn,
  workspaceCol: PgColumn,
  executorCol: PgColumn,
  includeExecutor = true,
): SQL {
  if (filters.matchNothing) return sql`false`;
  const clauses: (SQL | SQLWrapper)[] = [windowExpr(anchor, filters.hours)];
  if (filters.workspaceId) clauses.push(eq(workspaceCol, filters.workspaceId));
  if (includeExecutor && filters.executorType) clauses.push(eq(executorCol, filters.executorType));
  return and(...clauses) as SQL;
}

/** Truncate a Date to the start of its UTC hour or day. */
function truncUtc(granularity: MetricsGranularity, d: Date): number {
  const t = d.getTime();
  return granularity === 'hour'
    ? Math.floor(t / HOUR_MS) * HOUR_MS
    : Math.floor(t / DAY_MS) * DAY_MS;
}

/**
 * The dense, strictly-increasing bucket grid for a period, as ISO strings on
 * UTC hour/day boundaries — the exact `buckets` array of the response. Computed
 * on epoch ms so it matches {@link bucketMsExpr} keys bit-for-bit.
 */
export function generateBuckets(
  granularity: MetricsGranularity,
  hours: number,
  now: Date = new Date(),
): string[] {
  const step = granularity === 'hour' ? HOUR_MS : DAY_MS;
  const last = truncUtc(granularity, now);
  const first = truncUtc(granularity, new Date(now.getTime() - hours * HOUR_MS));
  const buckets: string[] = [];
  for (let t = first; t <= last; t += step) buckets.push(new Date(t).toISOString());
  return buckets;
}

/** Long DB row: one (bucket, category) aggregate. `value` is number or money-string. */
export interface AggRow {
  bucketMs: number;
  key: string;
  value: number | string;
}

interface PivotOptions {
  /** Serialize points as money strings (default numbers). */
  money?: boolean;
  /** Optional human-readable labels per category key. */
  labels?: Map<string, string>;
  /**
   * Force these category keys to always appear (zero-filled) even with no data
   * — e.g. the four token types. Order is preserved; data-only keys follow in
   * first-seen order.
   */
  forceKeys?: string[];
}

/**
 * Pivot long rows into dense `TimeBucketedSeries.series` (R5). Every series is
 * zero-filled to `buckets.length`; category order is `forceKeys` first, then
 * data keys in first-seen order.
 */
export function pivotSeries(
  rows: AggRow[],
  buckets: string[],
  opts: PivotOptions = {},
): MetricsSeries[] {
  const zero: number | string = opts.money ? '0' : 0;
  const indexByMs = new Map<number, number>();
  buckets.forEach((iso, i) => indexByMs.set(Date.parse(iso), i));

  const order: string[] = [...(opts.forceKeys ?? [])];
  const seen = new Set(order);
  const pointsByKey = new Map<string, (number | string)[]>();
  const ensure = (key: string) => {
    let pts = pointsByKey.get(key);
    if (!pts) {
      pts = new Array(buckets.length).fill(zero);
      pointsByKey.set(key, pts);
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    return pts;
  };
  for (const key of order) ensure(key);

  for (const row of rows) {
    const idx = indexByMs.get(row.bucketMs);
    if (idx === undefined) continue; // out-of-window guard
    ensure(row.key)[idx] = opts.money ? String(row.value) : Number(row.value);
  }

  return order.map((key) => ({
    key,
    ...(opts.labels?.has(key) ? { label: opts.labels.get(key)! } : {}),
    points: pointsByKey.get(key) ?? new Array(buckets.length).fill(zero),
  }));
}

/**
 * A single dense series with a constant key (cost_per_run, success_rate,
 * retry_rate, …). Always emitted (zero-filled) even with no data, so the
 * frontend always has the line to draw.
 */
export function singleSeries(
  rows: { bucketMs: number; value: number | string | null }[],
  buckets: string[],
  key: string,
  opts: { money?: boolean } = {},
): MetricsSeries[] {
  const mapped: AggRow[] = rows
    .filter((r) => r.value !== null)
    .map((r) => ({ bucketMs: r.bucketMs, key, value: r.value as number | string }));
  return pivotSeries(mapped, buckets, { money: opts.money, forceKeys: [key] });
}

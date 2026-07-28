import { describe, it, expect } from 'vitest';
import {
  MetricsActivityResponseSchema,
  MetricsCostResponseSchema,
  MetricsFilterQuerySchema,
  MetricsHumanResponseSchema,
  MetricsOverviewResponseSchema,
  MetricsReliabilityResponseSchema,
  TimeBucketedSeriesSchema,
} from './metrics.schema';

const series = (money = false) => ({
  granularity: 'day' as const,
  buckets: ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'],
  series: [{ key: 'k', points: money ? ['1.0000', '0'] : [1, 2] }],
});

/**
 * Metrics contracts round-trip (feature 029). Money-as-string, strict
 * envelopes, the shared filter tolerances, and the per-endpoint response shapes.
 */

describe('MetricsFilterQuerySchema', () => {
  it('defaults period to 7d and tolerates garbage (.catch)', () => {
    expect(MetricsFilterQuerySchema.parse({}).period).toBe('7d');
    expect(MetricsFilterQuerySchema.parse({ period: 'nonsense' }).period).toBe('7d');
    expect(MetricsFilterQuerySchema.parse({ period: '24h' }).period).toBe('24h');
  });

  it('accepts optional uuid workspace_id and a soft executor_type', () => {
    const ok = MetricsFilterQuerySchema.safeParse({
      period: '30d',
      workspace_id: '11111111-1111-4111-8111-111111111111',
      executor_type: 'kimi',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a non-uuid workspace_id at the schema layer', () => {
    expect(MetricsFilterQuerySchema.safeParse({ workspace_id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('TimeBucketedSeriesSchema', () => {
  const valid = {
    granularity: 'day',
    buckets: ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'],
    series: [
      { key: 'mock', points: [1, 2] },
      { key: 'cost', label: 'Cost', points: ['1.5000', '0'] },
    ],
  };

  it('accepts a dense series with numeric and money-string points', () => {
    expect(TimeBucketedSeriesSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown granularity and extra keys (strict)', () => {
    expect(
      TimeBucketedSeriesSchema.safeParse({ ...valid, granularity: 'week' }).success,
    ).toBe(false);
    expect(TimeBucketedSeriesSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe('MetricsOverviewResponseSchema', () => {
  const valid = {
    period: '7d',
    total_cost_usd: '12.3400',
    run_count_by_status: {
      queued: 0,
      running: 1,
      awaiting_human: 0,
      succeeded: 5,
      failed: 2,
      cancelled: 0,
      timed_out: 1,
      superseded: 0,
    },
    success_rate: 0.625,
    median_duration_s: 42,
    open_human_tasks: 3,
  };

  it('accepts a full summary; success_rate/median may be null', () => {
    expect(MetricsOverviewResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      MetricsOverviewResponseSchema.safeParse({
        ...valid,
        success_rate: null,
        median_duration_s: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a float total_cost_usd (money is a string) and a missing status key', () => {
    expect(
      MetricsOverviewResponseSchema.safeParse({ ...valid, total_cost_usd: 12.34 }).success,
    ).toBe(false);
    const { superseded: _omit, ...partial } = valid.run_count_by_status;
    expect(
      MetricsOverviewResponseSchema.safeParse({ ...valid, run_count_by_status: partial }).success,
    ).toBe(false);
  });
});

describe('MetricsCostResponseSchema', () => {
  const valid = {
    cost_by_executor: series(true),
    tokens_by_type: series(false),
    tokens_by_executor: series(false),
    tokens_by_model: series(false),
    tokens_by_role: series(false),
    cost_by_role: series(true),
    cost_per_run: series(true),
    tokens_per_run: series(false),
    top_workspaces_by_cost: [
      { workspace_id: 'w-1', name: 'Payments', total_cost_usd: '42.0000' },
    ],
  };

  it('accepts the cost blocks; top_workspaces may be empty', () => {
    expect(MetricsCostResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      MetricsCostResponseSchema.safeParse({ ...valid, top_workspaces_by_cost: [] }).success,
    ).toBe(true);
  });

  it('requires the tokens_by_executor block (executor token breakdown)', () => {
    const { tokens_by_executor: _omit, ...missing } = valid;
    expect(MetricsCostResponseSchema.safeParse(missing).success).toBe(false);
  });

  it('requires the per-role and per-run token blocks', () => {
    const { tokens_by_role: _r, ...noRole } = valid;
    expect(MetricsCostResponseSchema.safeParse(noRole).success).toBe(false);
    const { tokens_per_run: _t, ...noTpr } = valid;
    expect(MetricsCostResponseSchema.safeParse(noTpr).success).toBe(false);
    const { cost_by_role: _c, ...noCostRole } = valid;
    expect(MetricsCostResponseSchema.safeParse(noCostRole).success).toBe(false);
  });

  it('rejects a float total_cost_usd in a top-workspace row (money is string)', () => {
    expect(
      MetricsCostResponseSchema.safeParse({
        ...valid,
        top_workspaces_by_cost: [{ workspace_id: 'w-1', name: 'P', total_cost_usd: 42 }],
      }).success,
    ).toBe(false);
  });
});

describe('MetricsReliabilityResponseSchema', () => {
  it('accepts the six reliability blocks', () => {
    const valid = {
      runs_by_status: series(false),
      success_rate: series(false),
      duration_median_s: series(false),
      duration_p95_s: series(false),
      retry_rate: series(false),
      failstats_by_executor: series(false),
    };
    expect(MetricsReliabilityResponseSchema.safeParse(valid).success).toBe(true);
    const { retry_rate: _omit, ...missing } = valid;
    expect(MetricsReliabilityResponseSchema.safeParse(missing).success).toBe(false);
  });
});

describe('MetricsActivityResponseSchema', () => {
  it('accepts three breakdowns; a workspace series may carry a label', () => {
    const labelled = {
      granularity: 'day' as const,
      buckets: ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'],
      series: [{ key: 'w-1', label: 'Payments', points: [1, 2] }],
    };
    const valid = { by_source: series(false), by_role: series(false), by_workspace: labelled };
    expect(MetricsActivityResponseSchema.safeParse(valid).success).toBe(true);
  });
});

describe('MetricsHumanResponseSchema', () => {
  it('accepts the five human-in-the-loop blocks', () => {
    const valid = {
      latency_median_s: series(false),
      latency_p95_s: series(false),
      opened_by_kind: series(false),
      closed_by_kind: series(false),
      awaiting_human_share: series(false),
    };
    expect(MetricsHumanResponseSchema.safeParse(valid).success).toBe(true);
    const { awaiting_human_share: _omit, ...missing } = valid;
    expect(MetricsHumanResponseSchema.safeParse(missing).success).toBe(false);
  });
});

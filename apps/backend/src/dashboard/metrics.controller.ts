import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import type {
  MetricsActivityResponse,
  MetricsCostResponse,
  MetricsHumanResponse,
  MetricsOverviewResponse,
  MetricsReliabilityResponse,
  RunCountByStatus,
} from '@brigadir/contracts';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { DashboardTokenGuard } from './dashboard-token.guard';
import {
  bucketMsExpr,
  generateBuckets,
  parseMetricsFilters,
  pivotSeries,
  runsWhere,
  singleSeries,
  windowExpr,
  type AggRow,
  type MetricsFilters,
} from './metrics.helpers';

/** Token-type series keys, always present (zero-filled) in that order. */
const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_creation'] as const;

const RUN_STATUSES: (keyof RunCountByStatus)[] = [
  'queued',
  'running',
  'awaiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'superseded',
];

/**
 * Metrics timeline aggregates (feature 029, contracts/metrics-api.md). Five
 * read-only, pre-aggregated projections behind the shared bearer guard — no
 * Jira interaction, no writes, no credentials ever selected. Every response is
 * bounded by `period × granularity` (FR-013), never by the number of runs.
 *
 * Shared filters (period/workspace_id/executor_type) parse softly (never 4xx,
 * M8) via `parseMetricsFilters`; bucketing is explicit UTC (M4) via the
 * `metrics.helpers` module. `executor_type` is NOT applied to human-task
 * metrics (H1/FR-011a) — that entity has no executor type.
 */
@Controller('api/metrics')
@UseGuards(DashboardTokenGuard)
export class MetricsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get('overview')
  async overview(
    @Query('period') period?: string,
    @Query('workspace_id') workspaceId?: string,
    @Query('executor_type') executorType?: string,
  ): Promise<MetricsOverviewResponse> {
    const filters = parseMetricsFilters({
      period,
      workspace_id: workspaceId,
      executor_type: executorType,
    });
    const runWhere = runsWhere(
      filters,
      schema.runs.createdAt,
      schema.runs.workspaceId,
      schema.runs.executorType,
    );

    const [statusRows, aggRows, humanRows] = await Promise.all([
      this.db
        .select({ status: schema.runs.status, count: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(runWhere)
        .groupBy(schema.runs.status),
      this.db
        .select({
          total: sql<string | null>`coalesce(sum(${schema.runs.costUsd}), 0)::text`,
          // percentile_cont ignores NULL durations, so unfinished runs never
          // skew the median (FR-012); null when nothing has finished.
          medianS: sql<
            number | null
          >`percentile_cont(0.5) within group (order by extract(epoch from ${schema.runs.finishedAt} - ${schema.runs.startedAt}))`,
        })
        .from(schema.runs)
        .where(runWhere),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.humanTasks)
        .where(this.humanOpenWhere(filters)),
    ]);

    const counts = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as RunCountByStatus;
    for (const row of statusRows) {
      if ((RUN_STATUSES as string[]).includes(row.status)) {
        counts[row.status as keyof RunCountByStatus] = row.count;
      }
    }

    // Denominator excludes the non-terminal statuses (queued/running/
    // awaiting_human/superseded); null when nothing is decidable yet.
    const decided =
      counts.succeeded + counts.failed + counts.timed_out + counts.cancelled;
    const successRate = decided === 0 ? null : counts.succeeded / decided;

    return {
      period: filters.period,
      total_cost_usd: aggRows[0]?.total ?? '0',
      run_count_by_status: counts,
      success_rate: successRate,
      median_duration_s: aggRows[0]?.medianS ?? null,
      open_human_tasks: humanRows[0]?.count ?? 0,
    };
  }

  @Get('cost')
  async cost(
    @Query('period') period?: string,
    @Query('workspace_id') workspaceId?: string,
    @Query('executor_type') executorType?: string,
  ): Promise<MetricsCostResponse> {
    const filters = parseMetricsFilters({
      period,
      workspace_id: workspaceId,
      executor_type: executorType,
    });
    const { granularity } = filters;
    const buckets = generateBuckets(granularity, filters.hours);
    const bucket = bucketMsExpr(granularity, schema.runs.createdAt);
    const runWhere = runsWhere(
      filters,
      schema.runs.createdAt,
      schema.runs.workspaceId,
      schema.runs.executorType,
    );
    const usage = schema.runs.usage;
    const tokenSum = (jsonKey: string) =>
      sql<number>`coalesce(sum((${usage} ->> ${jsonKey})::bigint), 0)::float8`;
    // All token types summed per row (per-key coalesce so a missing field never
    // NULLs out the whole sum) — shared by the bucket total and the per-run
    // average below.
    const rowTokens = sql`coalesce((${usage} ->> 'input_tokens')::bigint, 0)
      + coalesce((${usage} ->> 'output_tokens')::bigint, 0)
      + coalesce((${usage} ->> 'cache_read_input_tokens')::bigint, 0)
      + coalesce((${usage} ->> 'cache_creation_input_tokens')::bigint, 0)`;
    // Summed over the bucket — the executor twin of the cost-by-executor stack.
    const totalTokenSum = sql<number>`coalesce(sum(${rowTokens}), 0)::float8`;

    // Tokens attributed to the MODEL each run actually used. The model is not a
    // column on `runs` — it is captured in the run's session-init `log` event
    // (`run_events.payload.model`, the same source the run card reads). `rm`
    // picks one model per run (earliest such log via DISTINCT ON); a LEFT JOIN
    // keeps runs with no model log, which coalesce to the '__unknown__' bucket
    // (FR-014 convention). No row multiplication — one `rm` row per run.
    const modelLookup = this.db
      .selectDistinctOn([schema.runEvents.runId], {
        runId: schema.runEvents.runId,
        model: sql<string>`${schema.runEvents.payload} ->> 'model'`.as('model'),
      })
      .from(schema.runEvents)
      .where(
        sql`${schema.runEvents.type} = 'log' and ${schema.runEvents.payload} ->> 'model' is not null`,
      )
      .orderBy(schema.runEvents.runId, schema.runEvents.id)
      .as('rm');
    const modelKey = sql<string>`coalesce(${modelLookup.model}, '__unknown__')`;

    // Agent-role breakdown (runs.agent_id → agents.role, the activity-tab
    // by_role convention). NULL role → '__unknown__'; the literal is inlined
    // (not a param) so SELECT and GROUP BY match.
    const roleKey = sql<string>`coalesce(${schema.agents.role}, '__unknown__')`;

    const [
      costRows,
      tokenRows,
      tokenExecRows,
      tokenModelRows,
      tokenRoleRows,
      costRoleRows,
      cprRows,
      tprRows,
      topRows,
    ] = await Promise.all([
      this.db
        .select({
          bucketMs: bucket,
          key: schema.runs.executorType,
          value: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)::text`,
        })
        .from(schema.runs)
        .where(runWhere)
        .groupBy(bucket, schema.runs.executorType),
      this.db
        .select({
          bucketMs: bucket,
          input: tokenSum('input_tokens'),
          output: tokenSum('output_tokens'),
          cacheRead: tokenSum('cache_read_input_tokens'),
          cacheCreation: tokenSum('cache_creation_input_tokens'),
        })
        .from(schema.runs)
        .where(runWhere)
        .groupBy(bucket),
      this.db
        .select({
          bucketMs: bucket,
          key: schema.runs.executorType,
          value: totalTokenSum,
        })
        .from(schema.runs)
        .where(runWhere)
        .groupBy(bucket, schema.runs.executorType),
      this.db
        .select({
          bucketMs: bucket,
          key: modelKey,
          value: totalTokenSum,
        })
        .from(schema.runs)
        .leftJoin(modelLookup, eq(modelLookup.runId, schema.runs.id))
        .where(runWhere)
        .groupBy(bucket, modelKey),
      this.db
        .select({
          bucketMs: bucket,
          key: roleKey,
          value: totalTokenSum,
        })
        .from(schema.runs)
        .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
        .where(runWhere)
        .groupBy(bucket, roleKey),
      this.db
        .select({
          bucketMs: bucket,
          key: roleKey,
          value: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)::text`,
        })
        .from(schema.runs)
        .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
        .where(runWhere)
        .groupBy(bucket, roleKey),
      this.db
        .select({
          bucketMs: bucket,
          // null when a bucket has no runs; NULL-cost buckets → null → "0" fill.
          value: sql<
            string | null
          >`(sum(${schema.runs.costUsd}) / nullif(count(*), 0))::text`,
        })
        .from(schema.runs)
        .where(runWhere)
        .groupBy(bucket),
      this.db
        .select({
          bucketMs: bucket,
          // Average tokens per run in the bucket; per-row coalesce means runs
          // with no usage still count in the denominator (a real run that
          // reported nothing dilutes the average, it doesn't vanish).
          value: sql<number | null>`(sum(${rowTokens}) / nullif(count(*), 0))::float8`,
        })
        .from(schema.runs)
        .where(runWhere)
        .groupBy(bucket),
      // Top-10 by spend — ONLY when no single workspace is selected (US2 AS3).
      filters.workspaceId
        ? Promise.resolve([] as { workspaceId: string; name: string; total: string }[])
        : this.db
            .select({
              workspaceId: schema.workspaces.id,
              name: schema.workspaces.name,
              total: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)::text`,
            })
            .from(schema.runs)
            .innerJoin(schema.workspaces, eq(schema.runs.workspaceId, schema.workspaces.id))
            .where(runWhere)
            .groupBy(schema.workspaces.id, schema.workspaces.name)
            // coalesce so a workspace with only NULL-cost runs (0) never sorts
            // above real spend (raw sum(NULL) is NULL → NULLS FIRST on DESC).
            .orderBy(desc(sql`coalesce(sum(${schema.runs.costUsd}), 0)`))
            .limit(10),
    ]);

    const tokenAgg: AggRow[] = tokenRows.flatMap((r) => [
      { bucketMs: r.bucketMs, key: 'input', value: r.input },
      { bucketMs: r.bucketMs, key: 'output', value: r.output },
      { bucketMs: r.bucketMs, key: 'cache_read', value: r.cacheRead },
      { bucketMs: r.bucketMs, key: 'cache_creation', value: r.cacheCreation },
    ]);

    return {
      cost_by_executor: {
        granularity,
        buckets,
        series: pivotSeries(costRows, buckets, { money: true }),
      },
      tokens_by_type: {
        granularity,
        buckets,
        series: pivotSeries(tokenAgg, buckets, { forceKeys: [...TOKEN_KEYS] }),
      },
      tokens_by_executor: {
        granularity,
        buckets,
        series: pivotSeries(tokenExecRows, buckets),
      },
      tokens_by_model: {
        granularity,
        buckets,
        series: pivotSeries(tokenModelRows, buckets),
      },
      tokens_by_role: {
        granularity,
        buckets,
        series: pivotSeries(tokenRoleRows, buckets),
      },
      cost_by_role: {
        granularity,
        buckets,
        series: pivotSeries(costRoleRows, buckets, { money: true }),
      },
      cost_per_run: {
        granularity,
        buckets,
        series: singleSeries(cprRows, buckets, 'cost_per_run', { money: true }),
      },
      tokens_per_run: {
        granularity,
        buckets,
        series: singleSeries(tprRows, buckets, 'tokens_per_run'),
      },
      top_workspaces_by_cost: topRows.map((r) => ({
        workspace_id: r.workspaceId,
        name: r.name,
        total_cost_usd: r.total,
      })),
    };
  }

  @Get('reliability')
  async reliability(
    @Query('period') period?: string,
    @Query('workspace_id') workspaceId?: string,
    @Query('executor_type') executorType?: string,
  ): Promise<MetricsReliabilityResponse> {
    const filters = parseMetricsFilters({
      period,
      workspace_id: workspaceId,
      executor_type: executorType,
    });
    const { granularity } = filters;
    const buckets = generateBuckets(granularity, filters.hours);

    // Most series anchor on created_at; the duration series anchor on
    // finished_at (FR-005a/M2) — a run crossing a day boundary lands in the
    // bucket it FINISHED, not the one it started.
    const createdBucket = bucketMsExpr(granularity, schema.runs.createdAt);
    const finishedBucket = bucketMsExpr(granularity, schema.runs.finishedAt);
    const createdWhere = runsWhere(
      filters,
      schema.runs.createdAt,
      schema.runs.workspaceId,
      schema.runs.executorType,
    );
    const finishedWhere = runsWhere(
      filters,
      schema.runs.finishedAt,
      schema.runs.workspaceId,
      schema.runs.executorType,
    );

    const durationExpr = sql`extract(epoch from ${schema.runs.finishedAt} - ${schema.runs.startedAt})`;
    const statusIn = (values: string[]) =>
      sql`${schema.runs.status} in (${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )})`;

    const [statusRows, rateRows, durRows, failRows] = await Promise.all([
      this.db
        .select({
          bucketMs: createdBucket,
          key: schema.runs.status,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.runs)
        .where(createdWhere)
        .groupBy(createdBucket, schema.runs.status),
      this.db
        .select({
          bucketMs: createdBucket,
          // succeeded / decided; null when nothing decided in the bucket.
          successRate: sql<
            number | null
          >`(count(*) filter (where ${statusIn(['succeeded'])}))::float8 / nullif(count(*) filter (where ${statusIn(['succeeded', 'failed', 'timed_out', 'cancelled'])}), 0)`,
          retryRate: sql<
            number | null
          >`(count(*) filter (where ${schema.runs.attempt} > 1))::float8 / nullif(count(*), 0)`,
        })
        .from(schema.runs)
        .where(createdWhere)
        .groupBy(createdBucket),
      this.db
        .select({
          bucketMs: finishedBucket,
          medianS: sql<number | null>`percentile_cont(0.5) within group (order by ${durationExpr})`,
          p95S: sql<number | null>`percentile_cont(0.95) within group (order by ${durationExpr})`,
        })
        .from(schema.runs)
        .where(finishedWhere)
        .groupBy(finishedBucket),
      this.db
        .select({
          bucketMs: createdBucket,
          key: schema.runs.executorType,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.runs)
        .where(and(createdWhere, statusIn(['failed', 'timed_out'])))
        .groupBy(createdBucket, schema.runs.executorType),
    ]);

    const block = (series: MetricsReliabilityResponse['runs_by_status']['series']) => ({
      granularity,
      buckets,
      series,
    });

    return {
      runs_by_status: block(pivotSeries(statusRows, buckets)),
      success_rate: block(
        singleSeries(
          rateRows.map((r) => ({ bucketMs: r.bucketMs, value: r.successRate })),
          buckets,
          'success_rate',
        ),
      ),
      duration_median_s: block(
        singleSeries(
          durRows.map((r) => ({ bucketMs: r.bucketMs, value: r.medianS })),
          buckets,
          'duration_median_s',
        ),
      ),
      duration_p95_s: block(
        singleSeries(
          durRows.map((r) => ({ bucketMs: r.bucketMs, value: r.p95S })),
          buckets,
          'duration_p95_s',
        ),
      ),
      retry_rate: block(
        singleSeries(
          rateRows.map((r) => ({ bucketMs: r.bucketMs, value: r.retryRate })),
          buckets,
          'retry_rate',
        ),
      ),
      failstats_by_executor: block(pivotSeries(failRows, buckets)),
    };
  }

  @Get('activity')
  async activity(
    @Query('period') period?: string,
    @Query('workspace_id') workspaceId?: string,
    @Query('executor_type') executorType?: string,
  ): Promise<MetricsActivityResponse> {
    const filters = parseMetricsFilters({
      period,
      workspace_id: workspaceId,
      executor_type: executorType,
    });
    const { granularity } = filters;
    const buckets = generateBuckets(granularity, filters.hours);
    const bucket = bucketMsExpr(granularity, schema.runs.createdAt);
    const where = runsWhere(
      filters,
      schema.runs.createdAt,
      schema.runs.workspaceId,
      schema.runs.executorType,
    );
    // NULL dimension → the '__unknown__' category (FR-014); the literal is
    // inlined (not a param) so SELECT and GROUP BY match.
    const source = sql<string>`coalesce(${schema.runs.triggerEvent} ->> 'source', '__unknown__')`;
    const role = sql<string>`coalesce(${schema.agents.role}, '__unknown__')`;
    const count = sql<number>`count(*)::int`;

    const [sourceRows, roleRows, workspaceRows] = await Promise.all([
      this.db
        .select({ bucketMs: bucket, key: source, value: count })
        .from(schema.runs)
        .where(where)
        .groupBy(bucket, source),
      this.db
        .select({ bucketMs: bucket, key: role, value: count })
        .from(schema.runs)
        .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
        .where(where)
        .groupBy(bucket, role),
      this.db
        .select({
          bucketMs: bucket,
          key: schema.workspaces.id,
          name: schema.workspaces.name,
          value: count,
        })
        .from(schema.runs)
        .innerJoin(schema.workspaces, eq(schema.runs.workspaceId, schema.workspaces.id))
        .where(where)
        .groupBy(bucket, schema.workspaces.id, schema.workspaces.name),
    ]);

    const wsLabels = new Map(workspaceRows.map((r) => [r.key, r.name]));

    return {
      by_source: { granularity, buckets, series: pivotSeries(sourceRows, buckets) },
      by_role: { granularity, buckets, series: pivotSeries(roleRows, buckets) },
      by_workspace: {
        granularity,
        buckets,
        series: pivotSeries(workspaceRows, buckets, { labels: wsLabels }),
      },
    };
  }

  @Get('human')
  async human(
    @Query('period') period?: string,
    @Query('workspace_id') workspaceId?: string,
    // NOTE: executor_type is intentionally NOT read — human metrics never take
    // it (H1/FR-011a); human_tasks has no executor type.
  ): Promise<MetricsHumanResponse> {
    const filters = parseMetricsFilters({ period, workspace_id: workspaceId });
    const { granularity } = filters;
    const buckets = generateBuckets(granularity, filters.hours);

    const createdBucket = bucketMsExpr(granularity, schema.humanTasks.createdAt);
    const resolvedBucket = bucketMsExpr(granularity, schema.humanTasks.resolvedAt);
    const openedWhere = this.humanTasksWhere(filters, schema.humanTasks.createdAt);
    const resolvedWhere = this.humanTasksWhere(filters, schema.humanTasks.resolvedAt);
    const latency = sql`extract(epoch from ${schema.humanTasks.resolvedAt} - ${schema.humanTasks.createdAt})`;
    const count = sql<number>`count(*)::int`;

    // awaiting_human_share is a RUNS metric (created_at anchor); still no
    // executor filter on this tab (H1).
    const runsBucket = bucketMsExpr(granularity, schema.runs.createdAt);
    const runsWhereNoExec = runsWhere(
      filters,
      schema.runs.createdAt,
      schema.runs.workspaceId,
      schema.runs.executorType,
      false,
    );

    const [latencyRows, openedRows, closedRows, shareRows] = await Promise.all([
      this.db
        .select({
          bucketMs: resolvedBucket,
          medianS: sql<number | null>`percentile_cont(0.5) within group (order by ${latency})`,
          p95S: sql<number | null>`percentile_cont(0.95) within group (order by ${latency})`,
        })
        .from(schema.humanTasks)
        .where(resolvedWhere)
        .groupBy(resolvedBucket),
      this.db
        .select({ bucketMs: createdBucket, key: schema.humanTasks.kind, value: count })
        .from(schema.humanTasks)
        .where(openedWhere)
        .groupBy(createdBucket, schema.humanTasks.kind),
      this.db
        .select({ bucketMs: resolvedBucket, key: schema.humanTasks.kind, value: count })
        .from(schema.humanTasks)
        .where(resolvedWhere)
        .groupBy(resolvedBucket, schema.humanTasks.kind),
      this.db
        .select({
          bucketMs: runsBucket,
          share: sql<
            number | null
          >`(count(*) filter (where ${schema.runs.status} = 'awaiting_human'))::float8 / nullif(count(*), 0)`,
        })
        .from(schema.runs)
        .where(runsWhereNoExec)
        .groupBy(runsBucket),
    ]);

    return {
      latency_median_s: {
        granularity,
        buckets,
        series: singleSeries(
          latencyRows.map((r) => ({ bucketMs: r.bucketMs, value: r.medianS })),
          buckets,
          'latency_median_s',
        ),
      },
      latency_p95_s: {
        granularity,
        buckets,
        series: singleSeries(
          latencyRows.map((r) => ({ bucketMs: r.bucketMs, value: r.p95S })),
          buckets,
          'latency_p95_s',
        ),
      },
      opened_by_kind: { granularity, buckets, series: pivotSeries(openedRows, buckets) },
      closed_by_kind: { granularity, buckets, series: pivotSeries(closedRows, buckets) },
      awaiting_human_share: {
        granularity,
        buckets,
        series: singleSeries(
          shareRows.map((r) => ({ bucketMs: r.bucketMs, value: r.share })),
          buckets,
          'awaiting_human_share',
        ),
      },
    };
  }

  /**
   * `human_tasks.status='open'` scoped to period (created_at) + workspace only.
   * `executor_type` is deliberately NOT applied (H1/FR-011a). `matchNothing`
   * (invalid workspace uuid, M8) collapses to `false`.
   */
  private humanOpenWhere(filters: MetricsFilters): SQL {
    if (filters.matchNothing) return sql`false`;
    const clauses: SQL[] = [
      eq(schema.humanTasks.status, 'open'),
      windowExpr(schema.humanTasks.createdAt, filters.hours),
    ];
    if (filters.workspaceId) clauses.push(eq(schema.humanTasks.workspaceId, filters.workspaceId));
    return and(...clauses) as SQL;
  }

  /**
   * human_tasks window on `anchor` (created_at or resolved_at) + workspace.
   * NO executor filter (H1/FR-011a). A resolved-anchor window inherently
   * excludes still-open tasks (NULL resolved_at fails the `>=` comparison).
   */
  private humanTasksWhere(filters: MetricsFilters, anchor: PgColumn): SQL {
    if (filters.matchNothing) return sql`false`;
    const clauses: SQL[] = [windowExpr(anchor, filters.hours)];
    if (filters.workspaceId) clauses.push(eq(schema.humanTasks.workspaceId, filters.workspaceId));
    return and(...clauses) as SQL;
  }
}

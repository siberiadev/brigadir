import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import type {
  HomeSummaryResponse,
  HomeWorkspacesResponse,
  RunStatus,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';

/**
 * Home dashboard aggregates (feature 017, contracts/home-api.md). Read-only
 * cross-workspace projections behind the shared bearer guard — no Jira
 * interaction, no writes, no credentials ever selected.
 *
 * Spend windows on `created_at` — the SAME column the per-workspace cost
 * endpoint uses — so the platform total always equals the sum of the
 * per-workspace figures (SC-004). Failure counters window on `finished_at`
 * (spec: "finished failed/timed_out within 24h").
 */
@Controller('api/home')
@UseGuards(DashboardTokenGuard)
export class HomeController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get('summary')
  async summary(): Promise<HomeSummaryResponse> {
    const spendCol = (hours: number) =>
      sql<
        string | null
      >`coalesce(sum(${schema.runs.costUsd}) filter (where ${schema.runs.createdAt} >= now() - (${hours} * interval '1 hour')), 0)::text`;
    const spendCount = (hours: number) =>
      sql<number>`(count(*) filter (where ${schema.runs.createdAt} >= now() - (${hours} * interval '1 hour')))::int`;

    const [liveRows, attentionRows, spendRows, humanRows] = await Promise.all([
      this.db
        .select({ status: schema.runs.status, count: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(inArray(schema.runs.status, ['running', 'queued']))
        .groupBy(schema.runs.status),
      this.db
        .select({ status: schema.runs.status, count: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(
          and(
            inArray(schema.runs.status, ['failed', 'timed_out']),
            sql`${schema.runs.finishedAt} >= now() - interval '24 hours'`,
          ),
        )
        .groupBy(schema.runs.status),
      this.db
        .select({
          total24: spendCol(24),
          count24: spendCount(24),
          total7d: spendCol(24 * 7),
          count7d: spendCount(24 * 7),
          total30d: spendCol(24 * 30),
          count30d: spendCount(24 * 30),
        })
        .from(schema.runs),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.humanTasks)
        .where(eq(schema.humanTasks.status, 'open')),
    ]);

    const byStatus = (rows: { status: string; count: number }[], status: string) =>
      rows.find((r) => r.status === status)?.count ?? 0;
    const spend = spendRows[0];

    return {
      running: byStatus(liveRows, 'running'),
      queued: byStatus(liveRows, 'queued'),
      attention_24h: {
        failed: byStatus(attentionRows, 'failed'),
        timed_out: byStatus(attentionRows, 'timed_out'),
      },
      human_open: humanRows[0]?.count ?? 0,
      spend: {
        '24h': { total_cost_usd: spend?.total24 ?? '0', run_count: spend?.count24 ?? 0 },
        '7d': { total_cost_usd: spend?.total7d ?? '0', run_count: spend?.count7d ?? 0 },
        '30d': { total_cost_usd: spend?.total30d ?? '0', run_count: spend?.count30d ?? 0 },
      },
    };
  }

  @Get('workspaces')
  async workspaces(): Promise<HomeWorkspacesResponse> {
    // ≤4 batched queries merged in memory — never a query per workspace (FR-020).
    const [wsRows, agentRows, lastRunRows, attentionRows] = await Promise.all([
      this.db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          projectKey: schema.workspaces.jiraProjectKey,
          boardType: schema.workspaces.jiraBoardType,
          settings: schema.workspaces.settings,
        })
        .from(schema.workspaces)
        // Same deterministic order as the existing workspaces list.
        .orderBy(schema.workspaces.createdAt),
      this.db
        .select({ workspaceId: schema.agents.workspaceId, count: sql<number>`count(*)::int` })
        .from(schema.agents)
        .groupBy(schema.agents.workspaceId),
      // Newest run per workspace — DISTINCT ON rides the runs_workspace_created
      // index; id desc breaks created_at ties deterministically.
      this.db
        .selectDistinctOn([schema.runs.workspaceId], {
          workspaceId: schema.runs.workspaceId,
          runId: schema.runs.id,
          status: schema.runs.status,
          startedAt: schema.runs.startedAt,
          finishedAt: schema.runs.finishedAt,
          createdAt: schema.runs.createdAt,
        })
        .from(schema.runs)
        .orderBy(schema.runs.workspaceId, desc(schema.runs.createdAt), desc(schema.runs.id)),
      this.db
        .select({ workspaceId: schema.runs.workspaceId, count: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(
          and(
            inArray(schema.runs.status, ['failed', 'timed_out']),
            sql`${schema.runs.finishedAt} >= now() - interval '24 hours'`,
          ),
        )
        .groupBy(schema.runs.workspaceId),
    ]);

    const agentCounts = new Map(agentRows.map((r) => [r.workspaceId, r.count]));
    const lastRuns = new Map(lastRunRows.map((r) => [r.workspaceId, r]));
    const attentionCounts = new Map(attentionRows.map((r) => [r.workspaceId, r.count]));

    return {
      items: wsRows.map((ws) => {
        const lastRun = lastRuns.get(ws.id);
        return {
          id: ws.id,
          name: ws.name,
          project_key: ws.projectKey,
          board_type: ws.boardType ?? null,
          // Absent flag ⇒ enabled; only an explicit `false` pauses (the
          // workspaces.controller convention).
          enabled: (ws.settings as { enabled?: unknown } | null)?.enabled !== false,
          agent_count: agentCounts.get(ws.id) ?? 0,
          last_run: lastRun
            ? {
                run_id: lastRun.runId,
                status: lastRun.status as RunStatus,
                started_at: lastRun.startedAt ? lastRun.startedAt.toISOString() : null,
                finished_at: lastRun.finishedAt ? lastRun.finishedAt.toISOString() : null,
                created_at: lastRun.createdAt.toISOString(),
              }
            : null,
          attention_24h: attentionCounts.get(ws.id) ?? 0,
        };
      }),
    };
  }
}

import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import {
  RunCostPeriodSchema,
  type RunCardResponse,
  type RunCancelResponse,
  type RunCostResponse,
  type RunListResponse,
  type RunRetryResponse,
  type RunStatus,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, notFoundError } from './dashboard.errors';
import { parsePagination } from './dashboard.helpers';

const PERIOD_HOURS: Record<string, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

/**
 * Dashboard runs surface (feature 006, US2 card + US3 table). All routes behind
 * the shared bearer guard, `snake_case` bodies. Every write is a read
 * projection, a GUARDED status flip (cancel — `WHERE status='running'`, never
 * overwriting `awaiting_human`, constitution rule #7), or the existing
 * manual-trigger path (retry — all three idempotency layers intact). This
 * feature writes NOTHING to Jira (deep links are built from stored fields).
 */
@Controller()
@UseGuards(DashboardTokenGuard)
export class RunsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runTrigger: RunTriggerService,
  ) {}

  // --- US3: runs table ---

  @Get('api/workspaces/:id/runs')
  async list(
    @Param('id') workspaceId: string,
    @Query('agent') agent?: string,
    @Query('status') status?: string,
    @Query('ticket') ticket?: string,
    @Query('source') source?: string,
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ): Promise<RunListResponse> {
    const { page, pageSize, limit, offset } = parsePagination(pageRaw, pageSizeRaw);

    const filters = [eq(schema.runs.workspaceId, workspaceId)];
    if (agent) filters.push(eq(schema.runs.agentId, agent));
    if (status) filters.push(eq(schema.runs.status, status));
    // Left-joined column: NULL never ilike-matches, so ticketless setup runs
    // simply never match a key filter — `source` is the way to find them.
    if (ticket) filters.push(ilike(schema.tickets.jiraKey, `%${ticket}%`));
    // Feature 011 (D11): trigger-source filter — drives the Generate button state.
    if (source) filters.push(sql`${schema.runs.triggerEvent} ->> 'source' = ${source}`);
    const where = and(...filters);

    const siteUrl = await this.workspaceSiteUrl(workspaceId);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.runs)
      .leftJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .where(where);

    const rows = await this.db
      .select({
        runId: schema.runs.id,
        agentId: schema.runs.agentId,
        agentName: schema.agents.name,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
        status: schema.runs.status,
        attempt: schema.runs.attempt,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        costUsd: schema.runs.costUsd,
        createdAt: schema.runs.createdAt,
      })
      .from(schema.runs)
      // Left join (feature 011): ticketless workspace-setup runs stay listed.
      .leftJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(where)
      .orderBy(desc(schema.runs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map((r) => ({
        run_id: r.runId,
        agent: { id: r.agentId, name: r.agentName },
        ticket:
          r.ticketKey === null
            ? null
            : { key: r.ticketKey, summary: r.ticketSummary, jira_url: deepLink(siteUrl, r.ticketKey) },
        status: r.status as RunStatus,
        attempt: r.attempt,
        duration_ms: durationMs(r.startedAt, r.finishedAt),
        started_at: r.startedAt ? r.startedAt.toISOString() : null,
        cost_usd: r.costUsd ?? null,
        created_at: r.createdAt.toISOString(),
      })),
      page,
      page_size: pageSize,
      total,
    };
  }

  @Get('api/workspaces/:id/runs/cost')
  async cost(
    @Param('id') workspaceId: string,
    @Query('period') periodRaw?: string,
  ): Promise<RunCostResponse> {
    const period = RunCostPeriodSchema.catch('7d').parse(periodRaw ?? '7d');
    const hours = PERIOD_HOURS[period];

    const [row] = await this.db
      .select({
        total: sql<string | null>`coalesce(sum(${schema.runs.costUsd}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.workspaceId, workspaceId),
          sql`${schema.runs.createdAt} >= now() - (${hours} * interval '1 hour')`,
        ),
      );

    return { period, total_cost_usd: row?.total ?? '0', run_count: row?.count ?? 0 };
  }

  // --- US2: run/ticket card ---

  @Get('api/runs/:id')
  async card(@Param('id') runId: string): Promise<RunCardResponse> {
    const [run] = await this.db
      .select({
        runId: schema.runs.id,
        workspaceId: schema.runs.workspaceId,
        ticketId: schema.runs.ticketId,
        agentId: schema.runs.agentId,
        agentName: schema.agents.name,
        status: schema.runs.status,
        attempt: schema.runs.attempt,
        executorType: schema.runs.executorType,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        costUsd: schema.runs.costUsd,
        usage: schema.runs.usage,
        outcome: schema.runs.outcome,
        externalRef: schema.runs.externalRef,
        error: schema.runs.error,
        createdAt: schema.runs.createdAt,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
        siteUrl: schema.workspaces.jiraSiteUrl,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      // Left join (feature 011): a ticketless setup run's card must resolve.
      .leftJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .innerJoin(schema.workspaces, eq(schema.runs.workspaceId, schema.workspaces.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) throw notFoundError('run_not_found', 'Run not found.');

    const checks = await this.db
      .select()
      .from(schema.runChecks)
      .where(eq(schema.runChecks.runId, runId))
      .orderBy(schema.runChecks.position);

    const events = await this.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.id);

    const history = await this.db
      .select({
        runId: schema.runs.id,
        agentName: schema.agents.name,
        executorType: schema.runs.executorType,
        attempt: schema.runs.attempt,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        costUsd: schema.runs.costUsd,
        outcome: schema.runs.outcome,
        status: schema.runs.status,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      // Ticketless runs: history = the workspace's setup runs (feature 011).
      .where(
        run.ticketId === null
          ? and(eq(schema.runs.workspaceId, run.workspaceId), isNull(schema.runs.ticketId))
          : eq(schema.runs.ticketId, run.ticketId),
      )
      .orderBy(desc(schema.runs.createdAt));

    return {
      run: {
        run_id: run.runId,
        workspace_id: run.workspaceId,
        status: run.status as RunStatus,
        attempt: run.attempt,
        executor_type: run.executorType,
        agent: { id: run.agentId, name: run.agentName },
        duration_ms: durationMs(run.startedAt, run.finishedAt),
        cost_usd: run.costUsd ?? null,
        usage: run.usage ?? undefined,
        outcome: run.outcome ?? null,
        external_ref: run.externalRef ?? null,
        error: run.error ?? null,
        created_at: run.createdAt.toISOString(),
        started_at: run.startedAt ? run.startedAt.toISOString() : null,
        finished_at: run.finishedAt ? run.finishedAt.toISOString() : null,
      },
      ticket:
        run.ticketKey === null
          ? null
          : {
              key: run.ticketKey,
              summary: run.ticketSummary,
              jira_url: deepLink(run.siteUrl, run.ticketKey),
            },
      checks: checks.map((c) => ({
        position: c.position,
        name: c.name,
        status: c.status as RunCardResponse['checks'][number]['status'],
        reason: c.reason ?? null,
      })),
      events: events.map((e) => ({
        id: String(e.id),
        type: e.type,
        payload: e.payload,
        created_at: e.createdAt.toISOString(),
      })),
      history: history.map((h) => ({
        run_id: h.runId,
        agent: h.agentName,
        executor_type: h.executorType,
        attempt: h.attempt,
        duration_ms: durationMs(h.startedAt, h.finishedAt),
        cost_usd: h.costUsd ?? null,
        outcome: h.outcome ?? null,
        status: h.status as RunStatus,
      })),
    };
  }

  // --- US2: cancel (guarded) + retry (manual-trigger) ---

  @Post('api/runs/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') runId: string): Promise<RunCancelResponse> {
    // Guarded flip (constitution rule #7 / FR-012): only a `running` run can be
    // cancelled — never overwrites `awaiting_human` or a terminal state.
    const flipped = await this.db
      .update(schema.runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
      .returning({ id: schema.runs.id });
    if (flipped.length > 0) return { ok: true, cancelled: true };

    const [exists] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!exists) throw notFoundError('run_not_found', 'Run not found.');
    return { ok: true, cancelled: false, reason: 'not_running' };
  }

  @Post('api/runs/:id/retry')
  @HttpCode(200)
  async retry(@Param('id') runId: string): Promise<RunRetryResponse> {
    const [run] = await this.db
      .select({ ticketId: schema.runs.ticketId, agentId: schema.runs.agentId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) throw notFoundError('run_not_found', 'Run not found.');

    // Reuse the manual-trigger path (all three idempotency layers intact).
    const result = await this.runTrigger.trigger({ ticketId: run.ticketId, agentId: run.agentId });
    if (result.deduplicated) {
      // `runs_one_active` rejected a second active run → surfaced cleanly (not a 500).
      throw conflictError('active_run_exists', 'An active run already exists for this ticket and agent.');
    }
    return { ok: true, run_id: result.runId, deduplicated: false };
  }

  // --- internals ---

  private async workspaceSiteUrl(workspaceId: string): Promise<string> {
    const [ws] = await this.db
      .select({ siteUrl: schema.workspaces.jiraSiteUrl })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return ws?.siteUrl ?? '';
  }
}

/** duration = finished−started (ms); running → now−started; null when not started. */
function durationMs(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt) return null;
  const end = finishedAt ?? new Date();
  return end.getTime() - startedAt.getTime();
}

/** Jira deep link built from stored fields — no live Jira call (FR-034). */
function deepLink(siteUrl: string, jiraKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/browse/${jiraKey}`;
}

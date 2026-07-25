import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import {
  GlobalRunsQuerySchema,
  RunCostPeriodSchema,
  normalizeReportArtifacts,
  type AgentReport,
  type GlobalRunsResponse,
  type RunCardResponse,
  type RunCancelResponse,
  type RunsCancelAllResponse,
  type RunCostResponse,
  type RunListResponse,
  type RunRetryResponse,
  type RunStatus,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, notFoundError, validationError, zodIssuePath } from './dashboard.errors';
import { deepLink, durationMs, parsePagination } from './dashboard.helpers';

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
        agentKey: schema.agents.key,
        agentRole: schema.agents.role,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
        status: schema.runs.status,
        attempt: schema.runs.attempt,
        executorType: schema.runs.executorType,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        costUsd: schema.runs.costUsd,
        createdAt: schema.runs.createdAt,
        // Feature 027 (FR-015): маркер недоставленных/сорвавшихся callbacks —
        // проекция существующих run_events (механизм 026), не новое хранилище.
        callbackAlert: sql<boolean>`EXISTS (
          SELECT 1 FROM ${schema.runEvents}
          WHERE ${schema.runEvents.runId} = ${schema.runs.id}
            AND ${schema.runEvents.type} IN ('undelivered_report', 'channel_failure')
        )`,
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
        agent: { id: r.agentId, name: r.agentName, key: r.agentKey, role: r.agentRole ?? null },
        ticket:
          r.ticketKey === null
            ? null
            : { key: r.ticketKey, summary: r.ticketSummary, jira_url: deepLink(siteUrl, r.ticketKey) },
        status: r.status as RunStatus,
        attempt: r.attempt,
        executor_type: r.executorType,
        duration_ms: durationMs(r.startedAt, r.finishedAt),
        started_at: r.startedAt ? r.startedAt.toISOString() : null,
        cost_usd: r.costUsd ?? null,
        created_at: r.createdAt.toISOString(),
        callback_alert: r.callbackAlert,
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

  // --- feature 017: bounded cross-workspace listing (contracts/runs-global-api.md) ---

  @Get('api/runs')
  async globalList(
    @Query('status') statusRaw?: string,
    @Query('finished_within') finishedWithinRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<GlobalRunsResponse> {
    // `status` is REQUIRED and `limit` bounded by contract — an unbounded
    // "all runs everywhere" query is impossible (FR-014).
    const parsed = GlobalRunsQuerySchema.safeParse({
      ...(statusRaw !== undefined ? { status: statusRaw } : {}),
      ...(finishedWithinRaw !== undefined ? { finished_within: finishedWithinRaw } : {}),
      ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
    });
    if (!parsed.success) {
      throw validationError(
        'Invalid global runs query.',
        parsed.error.issues.map((i) => ({
          path: zodIssuePath(i.path),
          code: i.code,
          message: i.message,
          level: 'error' as const,
        })),
      );
    }
    const { status, finished_within, limit } = parsed.data;

    const filters = [inArray(schema.runs.status, status)];
    if (finished_within) {
      const hours = PERIOD_HOURS[finished_within];
      filters.push(sql`${schema.runs.finishedAt} >= now() - (${hours} * interval '1 hour')`);
    }
    const where = and(...filters);

    // Fixed composite ordering (no `order` param): running (longest-running
    // first, NULL started_at last) → queued (longest-waiting first) → terminal
    // (most recently finished first, NULL finished_at last); id tie-break.
    const statusRank = sql`case ${schema.runs.status} when 'running' then 0 when 'queued' then 1 else 2 end`;
    const withinRank = sql`case
      when ${schema.runs.status} = 'running' then extract(epoch from coalesce(${schema.runs.startedAt}, 'infinity'::timestamptz))
      when ${schema.runs.status} = 'queued' then extract(epoch from ${schema.runs.createdAt})
      else -extract(epoch from coalesce(${schema.runs.finishedAt}, '-infinity'::timestamptz))
    end`;

    // Filters touch only runs columns, so the full count needs no joins.
    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(where);

    const rows = await this.db
      .select({
        runId: schema.runs.id,
        agentId: schema.runs.agentId,
        agentName: schema.agents.name,
        agentKey: schema.agents.key,
        agentRole: schema.agents.role,
        ticketKey: schema.tickets.jiraKey,
        ticketSummary: schema.tickets.summary,
        workspaceId: schema.workspaces.id,
        workspaceName: schema.workspaces.name,
        siteUrl: schema.workspaces.jiraSiteUrl,
        status: schema.runs.status,
        attempt: schema.runs.attempt,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        costUsd: schema.runs.costUsd,
        createdAt: schema.runs.createdAt,
      })
      .from(schema.runs)
      // Left join: ticketless workspace-setup runs stay listed (feature 011).
      .leftJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .innerJoin(schema.workspaces, eq(schema.runs.workspaceId, schema.workspaces.id))
      .where(where)
      .orderBy(statusRank, withinRank, schema.runs.id)
      .limit(limit);

    return {
      items: rows.map((r) => ({
        run_id: r.runId,
        agent: { id: r.agentId, name: r.agentName, key: r.agentKey, role: r.agentRole ?? null },
        ticket:
          r.ticketKey === null
            ? null
            : { key: r.ticketKey, summary: r.ticketSummary, jira_url: deepLink(r.siteUrl, r.ticketKey) },
        workspace: { id: r.workspaceId, name: r.workspaceName },
        status: r.status as RunStatus,
        attempt: r.attempt,
        duration_ms: durationMs(r.startedAt, r.finishedAt),
        started_at: r.startedAt ? r.startedAt.toISOString() : null,
        finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
        cost_usd: r.costUsd ?? null,
        created_at: r.createdAt.toISOString(),
      })),
      total,
    };
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
        agentKey: schema.agents.key,
        agentRole: schema.agents.role,
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
        report: schema.runs.report,
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
        agent: { id: run.agentId, name: run.agentName, key: run.agentKey, role: run.agentRole ?? null },
        duration_ms: durationMs(run.startedAt, run.finishedAt),
        cost_usd: run.costUsd ?? null,
        // jsonb is untyped on the Drizzle side; the only writer is
        // recordCostUsage persisting the CLI terminal `result.usage` object.
        usage: (run.usage ?? undefined) as RunCardResponse['run']['usage'],
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
      // Feature 019: artifacts projected from the stored (scrubbed) report via
      // the shared normalizer — a legacy flat report arrives as one repo-less
      // line; commits collapse to a count for the card.
      artifacts: normalizeReportArtifacts((run.report ?? {}) as AgentReport).map((a) => ({
        repo: a.repo ?? null,
        branch: a.branch ?? null,
        pr_url: a.pr_url ?? null,
        commits_count: a.commits !== undefined ? a.commits.length : null,
        files_changed: a.files_changed ?? null,
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

  /**
   * Bulk stop: cancel every active-but-not-parked run of the workspace in one
   * guarded UPDATE. Scope is `queued` + `running` — a cancelled `queued` run's
   * job is dropped at pickup (markRunning guards `IN (queued, running)` and
   * returns false), a cancelled `running` run's process is killed by the
   * worker's cancel-poll. `awaiting_human` is deliberately excluded
   * (constitution rule #7 — the park is never overwritten by a bulk action).
   */
  @Post('api/workspaces/:id/runs/cancel-all')
  @HttpCode(200)
  async cancelAll(@Param('id') workspaceId: string): Promise<RunsCancelAllResponse> {
    const [ws] = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    if (!ws) throw notFoundError('workspace_not_found', 'Workspace not found.');

    const flipped = await this.db
      .update(schema.runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(
        and(
          eq(schema.runs.workspaceId, workspaceId),
          inArray(schema.runs.status, ['queued', 'running']),
        ),
      )
      .returning({ id: schema.runs.id });

    return { ok: true, cancelled_count: flipped.length };
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

import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import {
  type AnswerOption,
  type HumanQueueCountResponse,
  type HumanQueueItem,
  type HumanQueueKind,
  type HumanQueueListResponse,
  type HumanTaskClosedStatus,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { parsePagination } from './dashboard.helpers';

/**
 * Dashboard human-queue surface (feature 006, US1). The queue is GLOBAL across
 * workspaces (one list), though every task belongs to a workspace. Read-only
 * projections behind the shared bearer guard; the resolve action stays in
 * `libs/human-tasks` (feature 004). `snake_case` bodies.
 */
@Controller('api/human-tasks')
@UseGuards(DashboardTokenGuard)
export class HumanTasksController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async list(
    @Query('status') statusRaw?: string,
    @Query('workspace') workspace?: string,
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ): Promise<HumanQueueListResponse> {
    const closed = statusRaw === 'closed';
    const { page, pageSize, limit, offset } = parsePagination(pageRaw, pageSizeRaw);

    // The queue is global by default; the workspace tab (feature: workspace
    // Human queue) scopes it to one workspace via `?workspace=<id>` — served by
    // the same query, backed by the `human_tasks_open` (workspace_id, status)
    // partial index. The count endpoint stays global (sidebar badge).
    const statusFilter = closed
      ? inArray(schema.humanTasks.status, ['resolved', 'dismissed'])
      : eq(schema.humanTasks.status, 'open');
    const where = workspace
      ? and(statusFilter, eq(schema.humanTasks.workspaceId, workspace))
      : statusFilter;

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.humanTasks)
      .where(where);

    const base = this.db
      .select({
        id: schema.humanTasks.id,
        kind: schema.humanTasks.kind,
        title: schema.humanTasks.title,
        details: schema.humanTasks.details,
        options: schema.humanTasks.options,
        blocking: schema.humanTasks.blocking,
        runId: schema.humanTasks.runId,
        createdAt: schema.humanTasks.createdAt,
        status: schema.humanTasks.status,
        resolution: schema.humanTasks.resolution,
        resolvedBy: schema.humanTasks.resolvedBy,
        resolvedAt: schema.humanTasks.resolvedAt,
        ticketKey: schema.tickets.jiraKey,
        siteUrl: schema.workspaces.jiraSiteUrl,
        workspaceId: schema.workspaces.id,
        workspaceName: schema.workspaces.name,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
      })
      .from(schema.humanTasks)
      // Left join (feature 011): ticketless setup tasks (review/failure/question)
      // must stay listed and resolvable.
      .leftJoin(schema.tickets, eq(schema.humanTasks.ticketId, schema.tickets.id))
      .innerJoin(schema.workspaces, eq(schema.humanTasks.workspaceId, schema.workspaces.id))
      // agent is derived via the blocked run, when present.
      .leftJoin(schema.runs, eq(schema.humanTasks.runId, schema.runs.id))
      .leftJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id));

    const rows = closed
      ? await base
          .where(where)
          .orderBy(desc(schema.humanTasks.resolvedAt))
          .limit(limit)
          .offset(offset)
      : await base
          .where(where)
          // oldest-first: longest-waiting on top.
          .orderBy(schema.humanTasks.createdAt)
          .limit(limit)
          .offset(offset);

    return {
      items: rows.map((r) => {
        const item: HumanQueueItem = {
          id: r.id,
          kind: r.kind as HumanQueueKind,
          title: r.title,
          details: r.details ?? null,
          // feature 013: stored pre-validated/pre-scrubbed at intake.
          options: (r.options as AnswerOption[] | null) ?? null,
          blocking: r.blocking,
          ticket:
            r.ticketKey === null
              ? null
              : { key: r.ticketKey, jira_url: `${r.siteUrl.replace(/\/+$/, '')}/browse/${r.ticketKey}` },
          agent: r.agentId && r.agentName ? { id: r.agentId, name: r.agentName } : null,
          workspace: { id: r.workspaceId, name: r.workspaceName },
          run_id: r.runId ?? null,
          created_at: r.createdAt.toISOString(),
        };
        if (closed) {
          item.status = r.status as HumanTaskClosedStatus;
          item.resolution = r.resolution ?? null;
          item.resolved_by = r.resolvedBy ?? null;
          item.resolved_at = r.resolvedAt ? r.resolvedAt.toISOString() : null;
        }
        return item;
      }),
      page,
      page_size: pageSize,
      total,
    };
  }

  @Get('count')
  async count(): Promise<HumanQueueCountResponse> {
    const rows = await this.db
      .select({ id: schema.humanTasks.id })
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.status, 'open'));
    return { open: rows.length };
  }
}

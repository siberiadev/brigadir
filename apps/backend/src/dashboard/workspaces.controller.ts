import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { RunTriggerService } from '@brigadir/runs';
import { SetupApplyService } from '@brigadir/pipeline';
import type {
  AgentReport,
  ErrorIssue,
  RunStatus,
  TicketHistoryHumanTask,
  TicketHistoryResponse,
  TriggerEvent,
} from '@brigadir/contracts';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getWorkspaceSettings,
  getScopeJql,
  patchWorkspaceSettings,
  normalizeRepositoryIds,
  seedOrchestratorAgent,
  setWorkspaceInstructionSource,
  setWorkspaceInstructionToken,
  getGlobalInstructionSource,
} from '@brigadir/database';
import {
  JiraClientFactory,
  StatusesService,
  StatusesUnavailable,
  encodeJiraCredentials,
  decodeJiraCredentials,
  sealSecret,
  jqlEscape,
  buildScopeJql,
} from '@brigadir/jira';
import {
  WorkspaceVerifyRequestSchema,
  WorkspaceCreateRequestSchema,
  WorkspaceRotateRequestSchema,
  WorkspaceSettingsRequestSchema,
  EnvSecretsWriteRequestSchema,
  CreateTeamRequestSchema,
  TicketCountRequestSchema,
  type CreateTeamResponse,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type VerifyResponse,
  type WaitingListResponse,
  type WaitingTicket,
  type TicketCountResponse,
  type JiraBoardType,
  type EnvSecretKeys,
  type EnvSecretScope,
} from '@brigadir/contracts';
import { openEnvSecrets, sealEnvSecrets, envSecretKeys, type EnvSecretsDocument } from '@brigadir/executors';
import { SecretBoxError } from '@brigadir/jira';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, fieldError, notFoundError, statusesUnavailable, validationError, zodIssuePath } from './dashboard.errors';
import { deepLink, durationMs, extractBoardId, deriveCredentialStatus, parsePagination } from './dashboard.helpers';

/** Minimal response shape — avoids an `@types/express` dependency (same as agents.controller). */
interface DashboardHttpResponse {
  status(code: number): void;
}

const EMPTY_ENV_SECRET_KEYS: EnvSecretKeys = { workspace: [], repos: {}, agents: {} };

/**
 * Feature 031: names-only view of a workspace's sealed env-secrets blob for the
 * read surface. NULL blob ⇒ empty. A corrupt/unopenable blob yields empty keys
 * here (the loud fail-fast on unopenable secrets is reserved for RUN spawn,
 * D7/T027 — a corrupt blob must not break unrelated dashboard reads).
 */
function readEnvSecretKeys(blob: Buffer | Uint8Array | null): EnvSecretKeys {
  if (!blob) return EMPTY_ENV_SECRET_KEYS;
  try {
    return envSecretKeys(openEnvSecrets(blob));
  } catch (err) {
    if (err instanceof SecretBoxError) return EMPTY_ENV_SECRET_KEYS;
    throw err;
  }
}

/**
 * Dashboard workspaces surface (feature 005, US1/US2/US4). All routes behind the
 * shared bearer guard. Verify is pre-persist (throwaway client from candidate
 * creds); create RE-runs verify server-side before writing; credentials are
 * AES-256-GCM-encrypted at rest and NEVER serialized back.
 */
@Controller('api/workspaces')
@UseGuards(DashboardTokenGuard)
export class WorkspacesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly jiraFactory: JiraClientFactory,
    private readonly statuses: StatusesService,
    private readonly runTrigger: RunTriggerService,
    private readonly setupApply: SetupApplyService,
  ) {}

  @Get()
  async list(
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ): Promise<WorkspaceListResponse> {
    const { page, pageSize, limit, offset } = parsePagination(pageRaw, pageSizeRaw);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.workspaces);

    const rows = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      // Пагинация требует детерминированного порядка (UI-конвенция 2026-07-15).
      .orderBy(schema.workspaces.createdAt)
      .limit(limit)
      .offset(offset);

    // Per-row toResponse — N+1, приемлемо: ≤100 строк/страница, внутренний инструмент.
    const items = await Promise.all(rows.map((r) => this.toResponse(r.id)));
    return { items, page, page_size: pageSize, total };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown): Promise<VerifyResponse> {
    const parsed = WorkspaceVerifyRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);
    return this.runVerify(parsed.data);
  }

  /**
   * Live-Jira preview of the ticket count for the workspace's poller scope
   * (project + active sprint for scrum + `scope_jql`). Optional `status` narrows
   * to one status — mirroring how an agent triggers (status equality), so the
   * agent form can preview "how many tickets would trigger me". Uses the STORED
   * credentials (via forWorkspace) and the SAME scope builder as the poller;
   * `trigger_jql` is intentionally not applied (never executed at runtime).
   */
  @Post(':id/ticket-count')
  @HttpCode(200)
  async ticketCount(@Param('id') id: string, @Body() body: unknown): Promise<TicketCountResponse> {
    const parsed = TicketCountRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);

    const [ws] = await this.db
      .select({
        boardId: schema.workspaces.jiraBoardId,
        boardType: schema.workspaces.jiraBoardType,
        projectKey: schema.workspaces.jiraProjectKey,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!ws) throw notFoundError('workspace_not_found', 'Workspace not found.');

    const scopeJql = await getScopeJql(this.db, id);
    const jira = await this.jiraFactory.forWorkspace(id);

    // Scrum boards scope to the active sprint set (mirrors the poller; a board
    // may run several at once). No active sprint → idle: nothing would ingest,
    // so the count is 0 (FR-030 parity).
    let sprintIds: number[] = [];
    if (ws.boardType === 'scrum') {
      sprintIds = ws.boardId != null ? await jira.getActiveSprintIds(ws.boardId) : [];
      if (sprintIds.length === 0) {
        return { count: 0, jql: '', active_sprint_ids: [] };
      }
    }

    // Same builder the poller uses, WITHOUT `since` (full current scope), then
    // AND the optional status — this is exactly the set that would trigger an
    // agent bound to that status.
    let jql = buildScopeJql({
      boardType: ws.boardType as JiraBoardType,
      projectKey: ws.projectKey,
      sprintIds,
      scopeJql,
    });
    if (parsed.data.status) {
      // buildScopeJql appends "ORDER BY updated ASC"; splice the status clause
      // in before it so the JQL stays valid.
      const [where, order] = jql.split(/\s+ORDER BY\s+/i);
      jql = `${where} AND status = "${jqlEscape(parsed.data.status)}"${order ? ` ORDER BY ${order}` : ''}`;
    }

    const count = await jira.approximateCount(jql);
    return { count, jql, active_sprint_ids: sprintIds };
  }

  @Post()
  async create(@Body() body: unknown): Promise<WorkspaceResponse & { warnings?: ErrorIssue[] }> {
    const parsed = WorkspaceCreateRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);
    const req = parsed.data;

    // Server ALWAYS re-runs Verify before writing — never trusts the client.
    const verified = await this.runVerify({
      jira_site_url: req.jira_site_url,
      jira_email: req.jira_email,
      jira_api_token: req.jira_api_token,
      board: req.board,
    });

    const [row] = await this.db
      .insert(schema.workspaces)
      .values({
        name: req.name,
        jiraSiteUrl: req.jira_site_url,
        jiraProjectKey: verified.project_key,
        jiraBoardId: verified.board_id,
        jiraBoardType: verified.board_type,
        jiraCredentials: encodeJiraCredentials({
          email: req.jira_email,
          api_token: req.jira_api_token,
        }),
        jiraCredentialExpiresAt: new Date(req.expires_at),
        // feature 011 (FR-001/D14): a NEW workspace comes into existence PAUSED —
        // the single gate in front of a (possibly generated) team. The existing
        // Start switch (PUT :id/settings {enabled:true}) opens it.
        // feature 030: optional role-template source override (non-secret).
        settings: {
          // Feature 031: assign stable repo ids at creation so secret env can be
          // keyed by id immediately (admin create_workspace applies repo secrets
          // right after this insert).
          repositories: normalizeRepositoryIds(req.repositories),
          enabled: false,
          ...(req.agent_instructions ? { agent_instructions: req.agent_instructions } : {}),
        },
      })
      .returning({ id: schema.workspaces.id });

    // feature 030: seal the optional private-repo token into its column.
    if (req.agent_instructions_token) {
      await setWorkspaceInstructionToken(this.db, row.id, sealSecret(req.agent_instructions_token));
    }

    // Executors are PLATFORM-scoped (2026-07-13): workspace creation seeds
    // nothing — the global type-scoped backfill at bootstrap keeps the
    // agent-form picker non-empty.

    // feature 010 (FR-018): every workspace gets a "brigadir" orchestrator,
    // with the current default instruction copied in (FR-022, D9/D10).
    // feature 015 (FR-010): the rest of the seed comes from the brigadir agent
    // template; a dangling template executor falls back to the built-in profile,
    // surfaced via the same warnings[] convention as agent create/update.
    const seeded = await seedOrchestratorAgent(this.db, row.id);

    const response = await this.toResponse(row.id);
    if (!seeded.warning) return response;
    return {
      ...response,
      warnings: [
        {
          path: ['template', 'triage', 'executor'],
          code: 'fallback',
          message: seeded.warning,
          level: 'warning' as const,
        },
      ],
    };
  }

  /**
   * feature 011 (FR-002/003/004, contracts/generate-agents-api.md): start the
   * ticketless workspace-setup run of the seeded orchestrator. Preconditions
   * checked in order (first failure wins); a race slipping past them lands on
   * `runs_one_active_setup` → dedup → the same 409. The workspace's paused
   * state is NOT modified — the team is generated behind the Start gate.
   */
  @Post(':id/generate-agents')
  async generateAgents(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: DashboardHttpResponse,
  ): Promise<{ run_id: string }> {
    const [ws] = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!ws) throw notFoundError('workspace_not_found', 'Workspace not found.');

    const [worker] = await this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, id), eq(schema.agents.isOrchestrator, false)))
      .limit(1);
    if (worker) {
      throw conflictError('worker_agents_exist', 'This workspace already has worker agents.');
    }

    const [orchestrator] = await this.db
      .select({ id: schema.agents.id, behavior: schema.agents.behavior })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, id),
          eq(schema.agents.isOrchestrator, true),
          eq(schema.agents.enabled, true),
        ),
      )
      .limit(1);
    if (!orchestrator) {
      throw conflictError('no_orchestrator', 'No enabled orchestrator agent in this workspace.');
    }

    const [activeSetup] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.workspaceId, id),
          isNull(schema.runs.ticketId),
          inArray(schema.runs.status, ['queued', 'running', 'awaiting_human']),
        ),
      )
      .limit(1);
    if (activeSetup) {
      throw conflictError('setup_run_active', 'A workspace-setup run is already active.');
    }

    // Same mock_scenario threading as triage runs (pipeline.service precedent):
    // integration tests drive the loop via the orchestrator's behavior blob.
    const scenario = (orchestrator.behavior as { mock_scenario?: unknown } | null)?.mock_scenario;
    const result = await this.runTrigger.trigger({
      ticketId: null,
      agentId: orchestrator.id,
      triggerEvent: {
        source: 'workspace-setup',
        ...(typeof scenario === 'string' ? { mock_scenario: scenario } : {}),
      } as TriggerEvent,
    });
    if (result.deduplicated) {
      throw conflictError('setup_run_active', 'A workspace-setup run is already active.');
    }

    res.status(202);
    return { run_id: result.runId };
  }

  /**
   * feature 012 (admin MCP `brigadir-admin`): atomically spawn a team of worker
   * agents on a paused workspace. Reuses the feature-011 validator + applier via
   * `SetupApplyService.createTeamDirect` WITHOUT a run and WITHOUT a review task.
   * Preconditions (first failure wins): the workspace exists (404); it has no
   * worker agents yet (409 `worker_agents_exist` — v1 does not rebuild teams).
   * An invalid roster ⇒ 422 with path-qualified issues and ZERO agents created
   * (all-or-nothing, same shape the callback `team` repair loop returns).
   */
  @Post(':id/team')
  @HttpCode(201)
  async createTeam(@Param('id') id: string, @Body() body: unknown): Promise<CreateTeamResponse> {
    const parsed = CreateTeamRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);

    const [ws] = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!ws) throw notFoundError('workspace_not_found', 'Workspace not found.');

    const [worker] = await this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, id), eq(schema.agents.isOrchestrator, false)))
      .limit(1);
    if (worker) {
      throw conflictError('worker_agents_exist', 'This workspace already has worker agents.');
    }

    const result = await this.setupApply.createTeamDirect(id, parsed.data.agents);
    if (result.kind === 'invalid') {
      throw validationError(
        'Team could not be created.',
        result.issues.map((i) => ({ path: i.path, code: i.code, message: i.message, level: 'error' as const })),
      );
    }
    return { workspace_id: id, agents_created: result.agentsCreated };
  }

  @Get(':id/statuses')
  async getStatuses(
    @Param('id') id: string,
    @Query('refresh') refresh?: string,
  ): Promise<{ statuses: Awaited<ReturnType<StatusesService['get']>> }> {
    try {
      const statuses = await this.statuses.get(id, { refresh: refresh === 'true' });
      return { statuses };
    } catch (err) {
      if (err instanceof StatusesUnavailable) throw statusesUnavailable();
      throw err;
    }
  }

  /**
   * Feature 022 (contracts/dashboard-waiting.md): заблокированные тикеты в
   * trigger-статусах — «waiting on [keys]» + классификация. Чистое чтение БД
   * (diff-кэш blocked_*), свежесть = последний release-проход. Порядок —
   * канонический release-order (priority_id ASC NULLS LAST, jira_key ASC).
   */
  @Get(':id/waiting')
  async waiting(
    @Param('id') id: string,
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ): Promise<WaitingListResponse> {
    const [wsRow] = await this.db
      .select({ id: schema.workspaces.id, siteUrl: schema.workspaces.jiraSiteUrl })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!wsRow) throw notFoundError('workspace_not_found', 'Workspace not found.');

    const { page, pageSize, limit, offset } = parsePagination(pageRaw, pageSizeRaw);
    const waitingWhere = and(
      eq(schema.tickets.workspaceId, id),
      sql`${schema.tickets.blockedState} is not null`,
    );

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.tickets)
      .where(waitingWhere);

    const rows = await this.db
      .select({
        ticketId: schema.tickets.id,
        jiraKey: schema.tickets.jiraKey,
        summary: schema.tickets.summary,
        priorityId: schema.tickets.priorityId,
        priorityName: schema.tickets.priorityName,
        blockedBy: schema.tickets.blockedBy,
        blockedState: schema.tickets.blockedState,
      })
      .from(schema.tickets)
      .where(waitingWhere)
      .orderBy(sql`${schema.tickets.priorityId} asc nulls last`, schema.tickets.jiraKey)
      .limit(limit)
      .offset(offset);

    const items: WaitingTicket[] = rows.map((r) => ({
      ticket_id: r.ticketId,
      jira_key: r.jiraKey,
      jira_url: deepLink(wsRow.siteUrl, r.jiraKey),
      summary: r.summary,
      priority_id: r.priorityId,
      priority_name: r.priorityName,
      blocked_by: (r.blockedBy as string[] | null) ?? [],
      blocked_state: r.blockedState as WaitingTicket['blocked_state'],
    }));
    return { items, page, page_size: pageSize, total };
  }

  /**
   * История тикета — все прогоны одного тикета хронологически, с причинными
   * ссылками trigger_event (failing/deciding run), fail-чеками и routing-вердиктом
   * оркестратора. Адресация по (workspace, jira_key): UUID тикета клиенту не
   * отдаётся, а jira_key уникален только внутри workspace. Без пагинации —
   * прогонов на тикет единицы; порядок детерминирован (created_at, id).
   * Циклы доработки группирует клиентский презентер — сервер отдаёт плоско.
   */
  @Get(':id/tickets/:key/history')
  async ticketHistory(
    @Param('id') id: string,
    @Param('key') key: string,
  ): Promise<TicketHistoryResponse> {
    const [ticket] = await this.db
      .select({
        ticketId: schema.tickets.id,
        jiraKey: schema.tickets.jiraKey,
        summary: schema.tickets.summary,
        lastSeenStatus: schema.tickets.lastSeenStatus,
        priorityName: schema.tickets.priorityName,
        blockedState: schema.tickets.blockedState,
        workspaceName: schema.workspaces.name,
        siteUrl: schema.workspaces.jiraSiteUrl,
      })
      .from(schema.tickets)
      .innerJoin(schema.workspaces, eq(schema.tickets.workspaceId, schema.workspaces.id))
      .where(and(eq(schema.tickets.workspaceId, id), eq(schema.tickets.jiraKey, key)))
      .limit(1);
    if (!ticket) throw notFoundError('ticket_not_found', 'Ticket not found in this workspace.');

    const runRows = await this.db
      .select({
        runId: schema.runs.id,
        agentId: schema.runs.agentId,
        agentName: schema.agents.name,
        agentKey: schema.agents.key,
        agentRole: schema.agents.role,
        agentIsOrchestrator: schema.agents.isOrchestrator,
        executorType: schema.runs.executorType,
        status: schema.runs.status,
        outcome: schema.runs.outcome,
        attempt: schema.runs.attempt,
        createdAt: schema.runs.createdAt,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        costUsd: schema.runs.costUsd,
        triggerEvent: schema.runs.triggerEvent,
        report: schema.runs.report,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(eq(schema.runs.ticketId, ticket.ticketId))
      .orderBy(schema.runs.createdAt, schema.runs.id);

    const runIds = runRows.map((r) => r.runId);

    // Батч-выборки детей по собранным run id (паттерн run card: отдельные
    // запросы вместо одного широкого join'а).
    const failedChecks = runIds.length
      ? await this.db
          .select({
            runId: schema.runChecks.runId,
            name: schema.runChecks.name,
            reason: schema.runChecks.reason,
          })
          .from(schema.runChecks)
          .where(and(inArray(schema.runChecks.runId, runIds), eq(schema.runChecks.status, 'fail')))
          .orderBy(schema.runChecks.position)
      : [];

    const humanTaskRows = runIds.length
      ? await this.db
          .select({
            id: schema.humanTasks.id,
            runId: schema.humanTasks.runId,
            kind: schema.humanTasks.kind,
            title: schema.humanTasks.title,
            status: schema.humanTasks.status,
          })
          .from(schema.humanTasks)
          .where(inArray(schema.humanTasks.runId, runIds))
          .orderBy(schema.humanTasks.createdAt)
      : [];

    const checksByRun = new Map<string, { name: string; reason: string | null }[]>();
    for (const c of failedChecks) {
      const list = checksByRun.get(c.runId) ?? [];
      list.push({ name: c.name, reason: c.reason ?? null });
      checksByRun.set(c.runId, list);
    }
    const tasksByRun = new Map<string, TicketHistoryHumanTask[]>();
    for (const t of humanTaskRows) {
      if (!t.runId) continue;
      const list = tasksByRun.get(t.runId) ?? [];
      list.push({
        id: t.id,
        kind: t.kind as TicketHistoryHumanTask['kind'],
        title: t.title,
        status: t.status as TicketHistoryHumanTask['status'],
      });
      tasksByRun.set(t.runId, list);
    }

    // Суммирование numeric — в SQL (как runs/cost), не во float.
    const [agg] = await this.db
      .select({ total: sql<string | null>`coalesce(sum(${schema.runs.costUsd}), 0)::text` })
      .from(schema.runs)
      .where(eq(schema.runs.ticketId, ticket.ticketId));

    const runs = runRows.map((r) => {
      const trigger = (r.triggerEvent ?? {}) as TriggerEvent;
      const report = (r.report ?? null) as AgentReport | null;
      return {
        run_id: r.runId,
        agent: {
          id: r.agentId,
          name: r.agentName,
          key: r.agentKey,
          role: r.agentRole ?? null,
          is_orchestrator: r.agentIsOrchestrator,
        },
        executor_type: r.executorType,
        status: r.status as RunStatus,
        outcome: r.outcome ?? null,
        attempt: r.attempt,
        created_at: r.createdAt.toISOString(),
        started_at: r.startedAt ? r.startedAt.toISOString() : null,
        finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
        duration_ms: durationMs(r.startedAt, r.finishedAt),
        cost_usd: r.costUsd ?? null,
        trigger: {
          source: trigger.source ?? null,
          failing_run_id: trigger.failing_run_id ?? null,
          deciding_run_id: trigger.deciding_run_id ?? null,
          target_agent: trigger.target_agent ?? null,
        },
        summary: report?.summary ?? null,
        routing: report?.routing
          ? { target_agent: report.routing.target_agent, task: report.routing.task }
          : null,
        failed_checks: checksByRun.get(r.runId) ?? [],
        human_tasks: tasksByRun.get(r.runId) ?? [],
      };
    });

    const finishedTimes = runRows
      .map((r) => r.finishedAt)
      .filter((d): d is Date => d !== null)
      .map((d) => d.getTime());

    return {
      ticket: {
        key: ticket.jiraKey,
        summary: ticket.summary ?? null,
        jira_url: deepLink(ticket.siteUrl, ticket.jiraKey),
        last_seen_status: ticket.lastSeenStatus ?? null,
        priority_name: ticket.priorityName ?? null,
        blocked_state: ticket.blockedState ?? null,
      },
      workspace: { id, name: ticket.workspaceName },
      runs,
      aggregates: {
        runs_total: runs.length,
        rework_cycles: runs.filter((r) => r.trigger.source === 'rework').length,
        total_cost_usd: runs.length > 0 ? (agg?.total ?? '0') : null,
        first_run_at: runRows.length > 0 ? runRows[0].createdAt.toISOString() : null,
        last_finished_at:
          finishedTimes.length > 0 ? new Date(Math.max(...finishedTimes)).toISOString() : null,
      },
    };
  }

  /**
   * Точечный detail-эндпоинт (реш. 2026-07-15): потребители «одного workspace»
   * (шапка, настройки, лукапы по id) НЕ листают пагинированный список.
   */
  @Get(':id')
  async get(@Param('id') id: string): Promise<WorkspaceResponse> {
    const [row] = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!row) throw notFoundError('workspace_not_found', 'Workspace not found.');
    return this.toResponse(id);
  }

  @Put(':id/settings')
  async updateSettings(@Param('id') id: string, @Body() body: unknown): Promise<WorkspaceResponse> {
    const parsed = WorkspaceSettingsRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);
    // feature 030: the template-source override lives in settings and its token
    // in a sealed column — strip both from the plain settings patch (a token
    // must NEVER land in the jsonb blob).
    const { agent_instructions, agent_instructions_token, ...settingsPatch } = parsed.data;

    // Feature 031: one home per key — a non-secret env value must not collide
    // with a stored secret of the same name in the same scope. Checked against
    // the CURRENT sealed doc before persisting (409). Repos are matched by id.
    const [secRow] = await this.db
      .select({ envSecrets: schema.workspaces.envSecrets })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    const secretsDoc: EnvSecretsDocument = secRow?.envSecrets ? openEnvSecrets(secRow.envSecrets) : {};
    if (settingsPatch.env) {
      this.guardNoSecretCollision(settingsPatch.env, secretsDoc.workspace, 'workspace');
    }
    for (const repo of settingsPatch.repositories ?? []) {
      if (repo.id && repo.env) {
        this.guardNoSecretCollision(repo.env, secretsDoc.repos?.[repo.id], `repository "${repo.name}"`);
      }
    }

    const next = await patchWorkspaceSettings(this.db, id, settingsPatch);

    // Feature 031 (T029): prune sealed secrets for repositories that were
    // removed by this write (repo delete cascades its secrets).
    if (settingsPatch.repositories && secretsDoc.repos) {
      const liveIds = new Set((next.repositories ?? []).map((r) => r.id).filter(Boolean));
      const pruned: Record<string, Record<string, string>> = {};
      let changed = false;
      for (const [repoId, values] of Object.entries(secretsDoc.repos)) {
        if (liveIds.has(repoId)) pruned[repoId] = values;
        else changed = true;
      }
      if (changed) {
        const doc: EnvSecretsDocument = { ...secretsDoc, repos: pruned };
        await this.db
          .update(schema.workspaces)
          .set({ envSecrets: sealEnvSecrets(doc), updatedAt: sql`now()` })
          .where(eq(schema.workspaces.id, id));
      }
    }
    if (agent_instructions !== undefined) {
      await setWorkspaceInstructionSource(this.db, id, agent_instructions); // null clears
    }
    if (agent_instructions_token !== undefined) {
      // null or "" clears; a value seals & replaces.
      await setWorkspaceInstructionToken(
        this.db,
        id,
        agent_instructions_token ? sealSecret(agent_instructions_token) : null,
      );
    }
    return this.toResponse(id);
  }

  /**
   * Feature 031 (US2): write-only secret env. `set` upserts sealed values,
   * `delete` removes keys, scoped to workspace / one repository / one agent.
   * Values are NEVER echoed — the response carries only the names-only view.
   * A key that already exists as a NON-secret value in the same scope is a 409
   * (one home per key).
   */
  @Put(':id/env-secrets')
  async updateEnvSecrets(@Param('id') id: string, @Body() body: unknown): Promise<WorkspaceResponse> {
    const parsed = EnvSecretsWriteRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);
    const { scope, set, delete: del } = parsed.data;

    const [row] = await this.db
      .select({ settings: schema.workspaces.settings, envSecrets: schema.workspaces.envSecrets })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!row) throw notFoundError('workspace_not_found', 'Workspace not found.');
    const settings = (row.settings ?? {}) as {
      env?: Record<string, string>;
      repositories?: { id?: string; name: string; env?: Record<string, string> }[];
    };

    // Resolve the target scope + the plaintext map that shares its "one home".
    let plaintext: Record<string, string>;
    let apply: (doc: EnvSecretsDocument, next: Record<string, string> | undefined) => void;
    if (scope === 'workspace') {
      plaintext = settings.env ?? {};
      apply = (doc, next) => {
        if (next) doc.workspace = next;
        else delete doc.workspace;
      };
    } else if ('repository_id' in scope) {
      const repo = (settings.repositories ?? []).find((r) => r.id === scope.repository_id);
      if (!repo) throw notFoundError('repository_not_found', 'Repository not found in this workspace.');
      plaintext = repo.env ?? {};
      apply = (doc, next) => {
        doc.repos = { ...(doc.repos ?? {}) };
        if (next) doc.repos[scope.repository_id] = next;
        else delete doc.repos[scope.repository_id];
      };
    } else {
      const [agent] = await this.db
        .select({ behavior: schema.agents.behavior })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, scope.agent_id), eq(schema.agents.workspaceId, id)))
        .limit(1);
      if (!agent) throw notFoundError('agent_not_found', 'Agent not found in this workspace.');
      plaintext = ((agent.behavior ?? {}) as { env?: Record<string, string> }).env ?? {};
      apply = (doc, next) => {
        doc.agents = { ...(doc.agents ?? {}) };
        if (next) doc.agents[scope.agent_id] = next;
        else delete doc.agents[scope.agent_id];
      };
    }

    // One home per key: a secret must not shadow a non-secret of the same name.
    for (const key of Object.keys(set ?? {})) {
      if (key in plaintext) {
        throw conflictError(
          'env_key_conflict',
          `env key "${key}" is already defined as a non-secret value in this scope`,
        );
      }
    }

    // Read-modify-write the sealed doc. An unopenable existing blob is a hard
    // error here (fail loud — never silently drop stored secrets on a write).
    const doc: EnvSecretsDocument = row.envSecrets ? openEnvSecrets(row.envSecrets) : {};
    const current = this.scopeSubmap(doc, scope);
    const next: Record<string, string> = { ...current, ...(set ?? {}) };
    for (const key of del ?? []) delete next[key];
    apply(doc, Object.keys(next).length > 0 ? next : undefined);

    await this.db
      .update(schema.workspaces)
      .set({ envSecrets: sealEnvSecrets(doc), updatedAt: sql`now()` })
      .where(eq(schema.workspaces.id, id));
    return this.toResponse(id);
  }

  /** Reject (409) any plaintext env key that already exists as a secret in the same scope. */
  private guardNoSecretCollision(
    plaintext: Record<string, string>,
    secret: Record<string, string> | undefined,
    scopeLabel: string,
  ): void {
    if (!secret) return;
    for (const key of Object.keys(plaintext)) {
      if (key in secret) {
        throw conflictError(
          'env_key_conflict',
          `env key "${key}" is already defined as a secret in ${scopeLabel}`,
        );
      }
    }
  }

  /** The current secret submap for a scope inside a decrypted doc. */
  private scopeSubmap(doc: EnvSecretsDocument, scope: EnvSecretScope): Record<string, string> {
    if (scope === 'workspace') return doc.workspace ?? {};
    if ('repository_id' in scope) return doc.repos?.[scope.repository_id] ?? {};
    return doc.agents?.[scope.agent_id] ?? {};
  }

  @Put(':id/jira-connection')
  async rotate(@Param('id') id: string, @Body() body: unknown): Promise<WorkspaceResponse> {
    const parsed = WorkspaceRotateRequestSchema.safeParse(body);
    if (!parsed.success) throw zodToValidationError(parsed.error);
    const req = parsed.data;

    const [ws] = await this.db
      .select({
        siteUrl: schema.workspaces.jiraSiteUrl,
        boardId: schema.workspaces.jiraBoardId,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!ws) throw fieldError('Workspace not found.', ['id'], 'not_found', id);

    // Re-verify the NEW credentials live before replacing (old creds retained on failure).
    const client = this.jiraFactory.fromCredentials({
      siteUrl: ws.siteUrl,
      email: req.jira_email,
      apiToken: req.jira_api_token,
    });
    try {
      await client.getMyself();
    } catch {
      throw fieldError('Token could not be verified.', ['jira_api_token'], 'token_invalid');
    }

    // Rotate: replace encrypted creds + expiry. The LazyJiraClient memo is
    // invalidated automatically (the credential bytes change → new fingerprint).
    await this.db
      .update(schema.workspaces)
      .set({
        jiraCredentials: encodeJiraCredentials({
          email: req.jira_email,
          api_token: req.jira_api_token,
        }),
        jiraCredentialExpiresAt: new Date(req.expires_at),
        updatedAt: new Date(),
      })
      .where(eq(schema.workspaces.id, id));

    return this.toResponse(id);
  }

  // --- internals ---

  private async runVerify(req: {
    jira_site_url: string;
    jira_email: string;
    jira_api_token: string;
    board: string;
  }): Promise<VerifyResponse> {
    const client = this.jiraFactory.fromCredentials({
      siteUrl: req.jira_site_url,
      email: req.jira_email,
      apiToken: req.jira_api_token,
    });

    let displayName: string;
    try {
      displayName = (await client.getMyself()).displayName;
    } catch {
      throw fieldError('Token could not be verified.', ['jira_api_token'], 'token_invalid');
    }

    const boardId = extractBoardId(req.board);
    if (boardId == null) {
      throw fieldError('Board id could not be parsed.', ['board'], 'board_unparseable', req.board);
    }

    let board: { type: JiraBoardType; projectKey: string };
    try {
      board = await client.getBoard(boardId);
    } catch {
      throw fieldError('Board is not accessible with these credentials.', ['board'], 'board_forbidden', req.board);
    }

    return {
      bot_display_name: displayName,
      project_key: board.projectKey,
      board_id: boardId,
      board_type: board.type,
    };
  }

  private async toResponse(id: string): Promise<WorkspaceResponse> {
    const [row] = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    const settings = await getWorkspaceSettings(this.db, id);
    return {
      id: row.id,
      name: row.name,
      jira_site_url: row.jiraSiteUrl,
      project_key: row.jiraProjectKey,
      board_id: row.jiraBoardId ?? null,
      board_type: (row.jiraBoardType as JiraBoardType | null) ?? null,
      expires_at: row.jiraCredentialExpiresAt ? row.jiraCredentialExpiresAt.toISOString() : null,
      credential_status: deriveCredentialStatus(row.jiraCredentialExpiresAt),
      repositories: settings.repositories ?? [],
      // Feature 031: non-secret workspace env defaults (values shown openly) and
      // the names-only view of ALL secret env. Secret VALUES are never serialized.
      env: settings.env ?? {},
      env_secret_keys: readEnvSecretKeys(row.envSecrets),
      // Feature 008 (FR-014): the additive, non-breaking read-only fields the
      // Settings tab renders and seeds its edit modals from. Only `.email` is
      // surfaced — `api_token` is discarded, never serialized (Principle V).
      bot_email: this.decodeBotEmail(row.jiraCredentials),
      branch_prefix: settings.branch_prefix ?? null,
      scope_jql: settings.scope_jql ?? null,
      // Absent flag ⇒ enabled (data-model additive item 2; only `false` pauses).
      enabled: settings.enabled !== false,
      // Feature 020 (D2b): absent ⇒ OFF — scoping is strictly opt-in.
      ticket_scoping: settings.ticket_scoping === true,
      // Feature 030: the workspace override (non-secret), whether a sealed token
      // is stored (never the token), and which level is effective by config.
      agent_instructions: settings.agent_instructions ?? null,
      has_agent_instructions_token: row.agentInstructionsToken != null,
      effective_instructions_level: settings.agent_instructions
        ? 'workspace'
        : (await getGlobalInstructionSource(this.db)).source
          ? 'global'
          : 'builtin',
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /**
   * Decode ONLY the bot email from the credential blob for the read-only
   * Settings view (FR-014). `decodeJiraCredentials` THROWS on an unrecognized or
   * corrupt envelope (seen live in iteration 5 with placeholder credentials);
   * the list/detail endpoint must never 500 on one bad row, so decode is
   * fail-safe → `null`. `api_token` is discarded and never serialized.
   */
  private decodeBotEmail(blob: Buffer | Uint8Array | null): string | null {
    if (!blob) return null;
    try {
      return decodeJiraCredentials(blob).email ?? null;
    } catch {
      return null;
    }
  }
}

/** Map a zod parse failure to the shared path-qualified error shape. */
function zodToValidationError(error: { issues: { path: PropertyKey[]; message: string; code: string }[] }) {
  return validationError(
    'Request could not be validated.',
    error.issues.map((i) => ({ path: zodIssuePath(i.path), code: i.code, message: i.message, level: 'error' as const })),
  );
}

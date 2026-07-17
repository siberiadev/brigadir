import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { RunTriggerService } from '@brigadir/runs';
import { SetupApplyService } from '@brigadir/pipeline';
import type { ErrorIssue, TriggerEvent } from '@brigadir/contracts';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getWorkspaceSettings,
  patchWorkspaceSettings,
  seedOrchestratorAgent,
} from '@brigadir/database';
import {
  JiraClientFactory,
  StatusesService,
  StatusesUnavailable,
  encodeJiraCredentials,
  decodeJiraCredentials,
} from '@brigadir/jira';
import {
  WorkspaceVerifyRequestSchema,
  WorkspaceCreateRequestSchema,
  WorkspaceRotateRequestSchema,
  WorkspaceSettingsRequestSchema,
  CreateTeamRequestSchema,
  type CreateTeamResponse,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type VerifyResponse,
  type JiraBoardType,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, fieldError, notFoundError, statusesUnavailable, validationError, zodIssuePath } from './dashboard.errors';
import { extractBoardId, deriveCredentialStatus, parsePagination } from './dashboard.helpers';

/** Minimal response shape — avoids an `@types/express` dependency (same as agents.controller). */
interface DashboardHttpResponse {
  status(code: number): void;
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
        settings: { repositories: req.repositories, enabled: false },
      })
      .returning({ id: schema.workspaces.id });

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
    await patchWorkspaceSettings(this.db, id, parsed.data);
    return this.toResponse(id);
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
      // Feature 008 (FR-014): the additive, non-breaking read-only fields the
      // Settings tab renders and seeds its edit modals from. Only `.email` is
      // surfaced — `api_token` is discarded, never serialized (Principle V).
      bot_email: this.decodeBotEmail(row.jiraCredentials),
      branch_prefix: settings.branch_prefix ?? null,
      scope_jql: settings.scope_jql ?? null,
      // Absent flag ⇒ enabled (data-model additive item 2; only `false` pauses).
      enabled: settings.enabled !== false,
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

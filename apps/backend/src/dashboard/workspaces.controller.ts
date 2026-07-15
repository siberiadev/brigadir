import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getWorkspaceSettings,
  patchWorkspaceSettings,
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
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type VerifyResponse,
  type JiraBoardType,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { fieldError, notFoundError, statusesUnavailable, validationError } from './dashboard.errors';
import { extractBoardId, deriveCredentialStatus, parsePagination } from './dashboard.helpers';

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
  async create(@Body() body: unknown): Promise<WorkspaceResponse> {
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
        settings: { repositories: req.repositories },
      })
      .returning({ id: schema.workspaces.id });

    // Executors are PLATFORM-scoped (2026-07-13): workspace creation seeds
    // nothing — the global type-scoped backfill at bootstrap keeps the
    // agent-form picker non-empty.

    return this.toResponse(row.id);
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
function zodToValidationError(error: { issues: { path: (string | number)[]; message: string; code: string }[] }) {
  return validationError(
    'Request could not be validated.',
    error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message, level: 'error' as const })),
  );
}

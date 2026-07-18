import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { StatusesService, StatusesUnavailable } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import {
  AgentWriteRequestSchema,
  TestRunRequestSchema,
  lintAgent,
  slugifyAgentKey,
  ensureUniqueAgentKey,
  type AgentListResponse,
  type AgentResponse,
  type BoardStatus,
  type ErrorIssue,
  type LintableAgent,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { statusesUnavailable, validationError, zodIssuePath } from './dashboard.errors';
import { parsePagination } from './dashboard.helpers';

type AgentRow = typeof schema.agents.$inferSelect;

/** Minimal response shape — avoids an `@types/express` dependency. */
interface DashboardHttpResponse {
  status(code: number): unknown;
}

/**
 * Dashboard agents surface (feature 005, US2). CRUD runs the server-authoritative
 * mini-linter against the live board statuses before writing (blocking errors →
 * 422 with path-qualified issues; `status_cycle` → 201/200 + warnings[]). Delete
 * is soft (enabled=false) when the agent has runs, hard otherwise. Test-run
 * reuses the manual trigger path (3-level dedup intact).
 */
@Controller('api/agents')
@UseGuards(DashboardTokenGuard)
export class AgentsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly statuses: StatusesService,
    private readonly runTrigger: RunTriggerService,
  ) {}

  @Get()
  async list(
    @Query('workspace') workspaceId: string,
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ): Promise<AgentListResponse> {
    const { page, pageSize, limit, offset } = parsePagination(pageRaw, pageSizeRaw);
    const where = eq(schema.agents.workspaceId, workspaceId);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.agents)
      .where(where);

    const rows = await this.db
      .select()
      .from(schema.agents)
      .where(where)
      // feature 014: детерминированный порядок по key (name больше не уникален).
      .orderBy(schema.agents.key)
      .limit(limit)
      .offset(offset);

    return { items: rows.map(toAgentResponse), page, page_size: pageSize, total };
  }

  @Post()
  async create(@Body() body: unknown): Promise<AgentResponse & { warnings?: ErrorIssue[] }> {
    const req = this.parse(body);
    await this.validateRepositoryScope(req.workspace_id, req);
    const { warnings } = await this.lintOrThrow(req.workspace_id, req, undefined);

    // feature 014: the system derives the immutable key ONCE, here. Base slug from
    // name+role, made workspace-unique against existing keys ∪ reserved. The DB
    // UNIQUE(workspace_id, key) is the final guard — retry with a refreshed taken
    // set on a concurrent race.
    const base = slugifyAgentKey(req.name, req.role ?? null);
    let row: AgentRow | undefined;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      const key = ensureUniqueAgentKey(base, await this.workspaceKeys(req.workspace_id));
      try {
        [row] = await this.db
          .insert(schema.agents)
          .values({ ...this.toInsertValues(req), key })
          .returning();
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && attempt < 4) continue;
        throw err;
      }
    }
    return { ...toAgentResponse(row!), ...(warnings.length ? { warnings } : {}) };
  }

  /** feature 014: the set of keys already used in a workspace (∪ reserved handled by ensureUniqueAgentKey). */
  private async workspaceKeys(workspaceId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ key: schema.agents.key })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId));
    return new Set(rows.map((r) => r.key));
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AgentResponse & { warnings?: ErrorIssue[] }> {
    const req = this.parse(body);
    await this.validateRepositoryScope(req.workspace_id, req);

    const [existing] = await this.db
      .select({
        isOrchestrator: schema.agents.isOrchestrator,
        name: schema.agents.name,
        statusRunning: schema.agents.statusRunning,
        statusSuccess: schema.agents.statusSuccess,
        statusFailure: schema.agents.statusFailure,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .limit(1);
    if (!existing) {
      throw validationError('Agent not found.', [
        { path: ['id'], code: 'not_found', message: 'Agent not found.', level: 'error' },
      ]);
    }

    const values = this.toInsertValues(req);

    // feature 010 (FR-019): the orchestrator's identity (name), trigger fields
    // (never poll-triggered), and inert status placeholders are preserved; only
    // its instruction/description/limits/behavior/enabled are editable. Its
    // status-cycle isn't board-mapped, so the trigger-status lint is skipped.
    if (existing.isOrchestrator) {
      const [row] = await this.db
        .update(schema.agents)
        .set({
          executorId: values.executorId,
          description: values.description,
          instruction: values.instruction,
          behavior: values.behavior,
          timeoutMinutes: values.timeoutMinutes,
          maxBudgetUsd: values.maxBudgetUsd,
          maxAttempts: values.maxAttempts,
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
        })
        .where(eq(schema.agents.id, id))
        .returning();
      return toAgentResponse(row);
    }

    const { warnings } = await this.lintOrThrow(req.workspace_id, req, id);
    const [row] = await this.db
      .update(schema.agents)
      .set({
        executorId: values.executorId,
        name: values.name,
        role: values.role,
        description: values.description,
        instruction: values.instruction,
        triggerStatus: values.triggerStatus,
        triggerJql: values.triggerJql,
        statusRunning: values.statusRunning,
        statusSuccess: values.statusSuccess,
        statusFailure: values.statusFailure,
        behavior: values.behavior,
        timeoutMinutes: values.timeoutMinutes,
        maxBudgetUsd: values.maxBudgetUsd,
        maxAttempts: values.maxAttempts,
        ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
      })
      .where(eq(schema.agents.id, id))
      .returning();
    return { ...toAgentResponse(row), ...(warnings.length ? { warnings } : {}) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ soft_deleted: boolean }> {
    // feature 010 (FR-019): the orchestrator is non-deletable — disable it
    // instead (the supported off-switch). Reject with 409.
    const [agent] = await this.db
      .select({ isOrchestrator: schema.agents.isOrchestrator })
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .limit(1);
    if (agent?.isOrchestrator) {
      throw new ConflictException({
        ok: false,
        error: 'The orchestrator agent cannot be deleted; disable it instead.',
      });
    }

    const runs = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, id))
      .limit(1);
    if (runs.length > 0) {
      await this.db.update(schema.agents).set({ enabled: false }).where(eq(schema.agents.id, id));
      return { soft_deleted: true };
    }
    await this.db.delete(schema.agents).where(eq(schema.agents.id, id));
    return { soft_deleted: false };
  }

  @Post(':id/test-run')
  @HttpCode(200)
  async testRun(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: DashboardHttpResponse,
  ): Promise<{ run_id?: string; deduplicated?: boolean; existing_run_id?: string }> {
    const parsed = TestRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'Request could not be validated.',
        parsed.error.issues.map((i) => ({ path: zodIssuePath(i.path), code: i.code, message: i.message, level: 'error' as const })),
      );
    }

    const [agent] = await this.db
      .select({ workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .limit(1);
    if (!agent) {
      throw validationError('Agent not found.', [{ path: ['id'], code: 'not_found', message: 'Agent not found.', level: 'error' }]);
    }

    const ticketId = await this.upsertTicket(agent.workspaceId, parsed.data.ticket_key);
    // Reuse the manual-run path (RunTriggerService defaults triggerEvent to
    // { source: 'manual' }); the 3-level dedup stays intact.
    const result = await this.runTrigger.trigger({ ticketId, agentId: id });

    if (result.deduplicated) {
      return { deduplicated: true, existing_run_id: result.existingRunId };
    }
    res.status(202);
    return { run_id: result.runId };
  }

  // --- internals ---

  private parse(body: unknown) {
    const parsed = AgentWriteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'Agent could not be saved.',
        parsed.error.issues.map((i) => ({ path: zodIssuePath(i.path), code: i.code, message: i.message, level: 'error' as const })),
      );
    }
    return parsed.data;
  }

  /**
   * Feature 019 (FR-003): every name in the agent's repository scope —
   * `behavior.repositories[]` and the deprecated `behavior.repository` —
   * must reference a repository declared in the workspace's settings.
   * Config-time rejection with a per-entry field path (the run-time
   * pickWorkspaceRepositories error stays as the last-resort guard); skipped
   * when the workspace declares no repositories (yaml-fallback / repo-less
   * workspaces — run-time resolution is the guard there).
   */
  private async validateRepositoryScope(
    workspaceId: string,
    req: ReturnType<AgentsController['parse']>,
  ): Promise<void> {
    const behavior = (req.behavior ?? {}) as { repositories?: string[]; repository?: string | null };
    const names = behavior.repositories ?? [];
    const single = behavior.repository;
    if (names.length === 0 && !single) return;

    const [ws] = await this.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    const declared = new Set(
      (((ws?.settings ?? {}) as { repositories?: { name: string }[] }).repositories ?? []).map(
        (r) => r.name,
      ),
    );
    if (declared.size === 0) return;

    const issues: ErrorIssue[] = [];
    names.forEach((name, j) => {
      if (!declared.has(name)) {
        issues.push({
          path: ['behavior', 'repositories', String(j)],
          code: 'unknown_repository',
          message: `references unknown repository "${name}" — must match a workspace repository name`,
          level: 'error',
        });
      }
    });
    if (single && !declared.has(single)) {
      issues.push({
        path: ['behavior', 'repository'],
        code: 'unknown_repository',
        message: `references unknown repository "${single}" — must match a workspace repository name`,
        level: 'error',
      });
    }
    if (issues.length > 0) {
      throw validationError('Agent could not be saved.', issues);
    }
  }

  private async lintOrThrow(
    workspaceId: string,
    req: ReturnType<AgentsController['parse']>,
    editingId: string | undefined,
  ): Promise<{ warnings: ErrorIssue[] }> {
    let boardStatuses: BoardStatus[];
    try {
      boardStatuses = await this.statuses.get(workspaceId, { refresh: true });
    } catch (err) {
      if (err instanceof StatusesUnavailable) throw statusesUnavailable();
      throw err;
    }

    const existing = await this.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId));
    const others: LintableAgent[] = existing.map((a) => ({
      id: a.id,
      name: a.name,
      trigger_status: a.triggerStatus,
      trigger_jql: a.triggerJql,
      status_running: a.statusRunning,
      status_success: a.statusSuccess,
      status_failure: a.statusFailure,
      enabled: a.enabled,
    }));

    const candidate: LintableAgent = {
      id: editingId,
      name: req.name,
      trigger_status: req.trigger_status,
      trigger_jql: req.trigger_jql ?? null,
      status_running: req.status_running ?? null,
      status_success: req.status_success,
      status_failure: req.status_failure,
      enabled: true,
    };

    const { errors, warnings } = lintAgent(candidate, others, boardStatuses);
    if (errors.length > 0) {
      throw validationError('Agent could not be saved.', errors, warnings);
    }
    return { warnings };
  }

  private toInsertValues(req: ReturnType<AgentsController['parse']>) {
    const behavior: Record<string, unknown> = {
      ...req.behavior,
      ...(req.status_ids ? { status_ids: req.status_ids } : {}),
    };
    return {
      workspaceId: req.workspace_id,
      executorId: req.executor_id,
      name: req.name,
      // feature 014: role is editable; key is NOT here — it is create-only (derived
      // once) and the update path never sets it (immutability, FR-007).
      role: req.role ?? null,
      description: req.description ?? null,
      instruction: req.instruction,
      triggerStatus: req.trigger_status,
      triggerJql: req.trigger_jql ?? null,
      statusRunning: req.status_running ?? null,
      statusSuccess: req.status_success,
      statusFailure: req.status_failure,
      behavior,
      timeoutMinutes: req.timeout_minutes,
      maxBudgetUsd: req.max_budget_usd != null ? String(req.max_budget_usd) : null,
      maxAttempts: req.max_attempts,
    };
  }

  private async upsertTicket(workspaceId: string, jiraKey: string): Promise<string> {
    const [existing] = await this.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.workspaceId, workspaceId), eq(schema.tickets.jiraKey, jiraKey)))
      .limit(1);
    if (existing) return existing.id;
    const [row] = await this.db
      .insert(schema.tickets)
      // jiraId is NOT NULL; a manual test-run may not know the numeric id, so
      // the key doubles as a placeholder (the run reads the ticket by key).
      .values({ workspaceId, jiraKey, jiraId: jiraKey, summary: `Test run for ${jiraKey}` })
      .returning({ id: schema.tickets.id });
    return row.id;
  }
}

function toAgentResponse(a: AgentRow): AgentResponse {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    executor_id: a.executorId,
    name: a.name,
    key: a.key,
    role: a.role ?? null,
    description: a.description ?? null,
    is_orchestrator: a.isOrchestrator,
    instruction: a.instruction,
    trigger_status: a.triggerStatus,
    trigger_jql: a.triggerJql,
    status_running: a.statusRunning,
    status_success: a.statusSuccess,
    status_failure: a.statusFailure,
    behavior: (a.behavior ?? {}) as Record<string, unknown>,
    timeout_minutes: a.timeoutMinutes,
    max_budget_usd: a.maxBudgetUsd != null ? Number(a.maxBudgetUsd) : null,
    max_attempts: a.maxAttempts,
    enabled: a.enabled,
  };
}

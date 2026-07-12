import {
  Body,
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
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { StatusesService, StatusesUnavailable } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import {
  AgentWriteRequestSchema,
  TestRunRequestSchema,
  lintAgent,
  type AgentResponse,
  type BoardStatus,
  type ErrorIssue,
  type LintableAgent,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { statusesUnavailable, validationError } from './dashboard.errors';

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
  async list(@Query('workspace') workspaceId: string): Promise<AgentResponse[]> {
    const rows = await this.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId));
    return rows.map(toAgentResponse);
  }

  @Post()
  async create(@Body() body: unknown): Promise<AgentResponse & { warnings?: ErrorIssue[] }> {
    const req = this.parse(body);
    const { warnings } = await this.lintOrThrow(req.workspace_id, req, undefined);

    const [row] = await this.db
      .insert(schema.agents)
      .values(this.toInsertValues(req))
      .returning();
    return { ...toAgentResponse(row), ...(warnings.length ? { warnings } : {}) };
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AgentResponse & { warnings?: ErrorIssue[] }> {
    const req = this.parse(body);
    const { warnings } = await this.lintOrThrow(req.workspace_id, req, id);

    const values = this.toInsertValues(req);
    const [row] = await this.db
      .update(schema.agents)
      .set({
        executorId: values.executorId,
        name: values.name,
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
      })
      .where(eq(schema.agents.id, id))
      .returning();
    return { ...toAgentResponse(row), ...(warnings.length ? { warnings } : {}) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ soft_deleted: boolean }> {
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
        parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message, level: 'error' as const })),
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
        parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message, level: 'error' as const })),
      );
    }
    return parsed.data;
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

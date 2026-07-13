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
  Res,
  UseGuards,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema, getRepositories } from '@brigadir/database';
import {
  ExecutorCreateRequestSchema,
  ExecutorUpdateRequestSchema,
  type ExecutorCreateRequest,
  type ExecutorListResponse,
  type ExecutorResponse,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, fieldError, notFoundError, validationError } from './dashboard.errors';

type ExecutorRow = typeof schema.executors.$inferSelect;

/** Minimal response shape — avoids an `@types/express` dependency (mirrors agents.controller). */
interface DashboardHttpResponse {
  status(code: number): unknown;
}

/**
 * Dashboard executors surface (feature 006, US4 — iteration-5 debt). CRUD under
 * `/api/workspaces/:id/executors`, behind the shared bearer guard. Typed-config
 * validation via the shared `executor.schema` union (foreign field / missing
 * required → 422). `concurrency_limit` maps to its column; every other typed
 * field to `config` jsonb (stored camelCase — the executor runtime's shape).
 * Secrets are NEVER serialized. Delete is guarded by a pre-count of referencing
 * agents → 409 `executor_in_use`.
 */
@Controller('api/workspaces/:id/executors')
@UseGuards(DashboardTokenGuard)
export class ExecutorsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async list(@Param('id') workspaceId: string): Promise<ExecutorListResponse> {
    const rows = await this.db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.workspaceId, workspaceId));
    return { items: rows.map(toExecutorResponse) };
  }

  @Post()
  async create(@Param('id') workspaceId: string, @Body() body: unknown): Promise<ExecutorResponse> {
    const req = this.parse(body, ExecutorCreateRequestSchema);
    await this.validateRepository(workspaceId, req);

    const values = toInsertValues(workspaceId, req);
    let row: ExecutorRow;
    try {
      [row] = await this.db.insert(schema.executors).values(values).returning();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflictError('executor_name_taken', `An executor named "${req.name}" already exists.`);
      }
      throw err;
    }
    return toExecutorResponse(row);
  }

  @Put(':executorId')
  async update(
    @Param('id') workspaceId: string,
    @Param('executorId') executorId: string,
    @Body() body: unknown,
  ): Promise<ExecutorResponse> {
    const req = this.parse(body, ExecutorUpdateRequestSchema);
    await this.validateRepository(workspaceId, req);

    const values = toInsertValues(workspaceId, req);
    let rows: ExecutorRow[];
    try {
      rows = await this.db
        .update(schema.executors)
        .set({
          type: values.type,
          name: values.name,
          config: values.config,
          concurrencyLimit: values.concurrencyLimit,
        })
        .where(
          and(eq(schema.executors.id, executorId), eq(schema.executors.workspaceId, workspaceId)),
        )
        .returning();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflictError('executor_name_taken', `An executor named "${req.name}" already exists.`);
      }
      throw err;
    }
    if (rows.length === 0) throw notFoundError('executor_not_found', 'Executor not found.');
    return toExecutorResponse(rows[0]);
  }

  @Delete(':executorId')
  @HttpCode(204)
  async remove(
    @Param('id') workspaceId: string,
    @Param('executorId') executorId: string,
    @Res({ passthrough: true }) res: DashboardHttpResponse,
  ): Promise<void> {
    const [executor] = await this.db
      .select({ id: schema.executors.id, name: schema.executors.name })
      .from(schema.executors)
      .where(
        and(eq(schema.executors.id, executorId), eq(schema.executors.workspaceId, workspaceId)),
      )
      .limit(1);
    if (!executor) throw notFoundError('executor_not_found', 'Executor not found.');

    const referencing = await this.db
      .select({ name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.executorId, executorId));
    if (referencing.length > 0) {
      const names = referencing.map((a) => a.name).join(', ');
      throw conflictError('executor_in_use', `Executor "${executor.name}" is used by agents: ${names}`);
    }

    await this.db.delete(schema.executors).where(eq(schema.executors.id, executorId));
    res.status(204);
  }

  // --- internals ---

  private parse<T>(body: unknown, schemaDef: { safeParse: (b: unknown) => { success: boolean; data?: T; error?: { issues: { path: (string | number)[]; message: string; code: string }[] } } }): T {
    const parsed = schemaDef.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'Executor could not be saved.',
        parsed.error!.issues.map((i) => ({ path: i.path, code: i.code, message: i.message, level: 'error' as const })),
      );
    }
    return parsed.data!;
  }

  /** claude_cli.repository (when non-empty) MUST be one of the workspace's repositories. */
  private async validateRepository(workspaceId: string, req: ExecutorCreateRequest): Promise<void> {
    if (req.type !== 'claude_cli' || req.repository === '') return;
    const repos = await getRepositories(this.db, workspaceId);
    if (!repos.some((r) => r.name === req.repository)) {
      throw fieldError(
        `Repository "${req.repository}" is not one of the workspace's repositories.`,
        ['repository'],
        'unknown_repository',
        req.repository,
      );
    }
  }
}

/** API request (snake_case) → storage values (camelCase config jsonb + columns). */
function toInsertValues(workspaceId: string, req: ExecutorCreateRequest) {
  const config: Record<string, unknown> =
    req.type === 'claude_cli'
      ? {
          model: req.model,
          cliPath: req.cli_path,
          repository: req.repository,
          useCallbackChannel: req.use_callback_channel,
          keepFailedWorktrees: req.keep_failed_worktrees,
          maxTurns: req.max_turns,
        }
      : {};
  return {
    workspaceId,
    type: req.type,
    name: req.name,
    concurrencyLimit: req.concurrency_limit,
    config,
    // NOTE: `secrets` is accepted in the request schema for forward-compat but
    // the per-type configs carry no secret fields today; a plaintext store would
    // violate secret-at-rest, so we intentionally do not persist it here.
  };
}

/** Storage row → API response (camelCase config → snake_case; secrets never serialized). */
function toExecutorResponse(row: ExecutorRow): ExecutorResponse {
  const stored = (row.config ?? {}) as Record<string, unknown>;
  const config: Record<string, unknown> =
    row.type === 'claude_cli'
      ? {
          model: stored.model,
          cli_path: stored.cliPath,
          repository: stored.repository,
          use_callback_channel: stored.useCallbackChannel,
          keep_failed_worktrees: stored.keepFailedWorktrees,
          max_turns: stored.maxTurns,
        }
      : {};
  return {
    id: row.id,
    type: row.type as ExecutorResponse['type'],
    name: row.name,
    enabled: row.enabled,
    concurrency_limit: row.concurrencyLimit,
    config,
  };
}

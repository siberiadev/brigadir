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
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import {
  ExecutorCreateRequestSchema,
  ExecutorUpdateRequestSchema,
  type ExecutorCreateRequest,
  type ExecutorListResponse,
  type ExecutorResponse,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, notFoundError, validationError } from './dashboard.errors';

type ExecutorRow = typeof schema.executors.$inferSelect;

/** Minimal response shape — avoids an `@types/express` dependency (mirrors agents.controller). */
interface DashboardHttpResponse {
  status(code: number): unknown;
}

/**
 * Executors surface, PLATFORM-scoped (2026-07-13): an executor is physical
 * capacity (the CLI on the host, a subscription/API key), so CRUD lives under
 * `/api/executors` — no workspace in the path. Behind the shared bearer guard.
 * Typed-config validation via the shared `executor.schema` union (foreign
 * field / missing required → 422). `concurrency_limit` maps to its column;
 * every other typed field to `config` jsonb (stored camelCase — the executor
 * runtime's shape). Secrets are NEVER serialized. Names are globally unique
 * (409 `executor_name_taken`); delete is guarded by a pre-count of referencing
 * agents across ALL workspaces → 409 `executor_in_use`.
 */
@Controller('api/executors')
@UseGuards(DashboardTokenGuard)
export class ExecutorsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async list(): Promise<ExecutorListResponse> {
    const rows = await this.db.select().from(schema.executors).orderBy(schema.executors.name);
    return { items: rows.map(toExecutorResponse) };
  }

  @Post()
  async create(@Body() body: unknown): Promise<ExecutorResponse> {
    const req = this.parse(body, ExecutorCreateRequestSchema);

    const values = toInsertValues(req);
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
  async update(@Param('executorId') executorId: string, @Body() body: unknown): Promise<ExecutorResponse> {
    const req = this.parse(body, ExecutorUpdateRequestSchema);

    const values = toInsertValues(req);
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
        .where(eq(schema.executors.id, executorId))
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
    @Param('executorId') executorId: string,
    @Res({ passthrough: true }) res: DashboardHttpResponse,
  ): Promise<void> {
    const [executor] = await this.db
      .select({ id: schema.executors.id, name: schema.executors.name })
      .from(schema.executors)
      .where(eq(schema.executors.id, executorId))
      .limit(1);
    if (!executor) throw notFoundError('executor_not_found', 'Executor not found.');

    // The executor is platform capacity — agents in EVERY workspace may hold it.
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
}

/** API request (snake_case) → storage values (camelCase config jsonb + columns). */
function toInsertValues(req: ExecutorCreateRequest) {
  const config: Record<string, unknown> =
    req.type === 'claude_cli'
      ? {
          model: req.model,
          cliPath: req.cli_path,
          useCallbackChannel: req.use_callback_channel,
          keepFailedWorktrees: req.keep_failed_worktrees,
          maxTurns: req.max_turns,
        }
      : {};
  return {
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

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
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import {
  ExecutorCreateRequestSchema,
  ExecutorUpdateRequestSchema,
  type ExecutorCreateRequest,
  type ExecutorListResponse,
  type ExecutorResponse,
} from '@brigadir/contracts';
import { sealExecutorSecrets } from '@brigadir/executors';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { conflictError, notFoundError, validationError, zodIssuePath } from './dashboard.errors';
import { parsePagination } from './dashboard.helpers';

type ExecutorRow = typeof schema.executors.$inferSelect;

/** Minimal response shape — avoids an `@types/express` dependency (mirrors agents.controller). */
interface DashboardHttpResponse {
  status(code: number): unknown;
}

/**
 * Executors surface — NAMED RUNNER PROFILES (2026-07-14; platform-scoped since
 * 2026-07-13): a row is a runtime profile (transport type + model + limits +
 * optional credentials), so CRUD lives under `/api/executors` — no workspace
 * in the path. Behind the shared bearer guard. Typed-config validation via the
 * shared `executor.schema` union (foreign field / missing required → 422).
 * `max_parallel_runs` maps to its column; every other typed field to `config`
 * jsonb (stored camelCase — the executor runtime's shape). The optional
 * `api_key` is WRITE-ONLY: sealed (AES-256-GCM, the workspace-credentials
 * envelope) into `executors.secrets`; responses carry `has_api_key` only.
 * Names are globally unique (409 `executor_name_taken`); delete is guarded by
 * a pre-count of referencing agents across ALL workspaces → 409
 * `executor_in_use`.
 */
@Controller('api/executors')
@UseGuards(DashboardTokenGuard)
export class ExecutorsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async list(
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ): Promise<ExecutorListResponse> {
    const { page, pageSize, limit, offset } = parsePagination(pageRaw, pageSizeRaw);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.executors);

    const rows = await this.db
      .select()
      .from(schema.executors)
      .orderBy(schema.executors.name)
      .limit(limit)
      .offset(offset);

    return { items: rows.map(toExecutorResponse), page, page_size: pageSize, total };
  }

  @Post()
  async create(@Body() body: unknown): Promise<ExecutorResponse> {
    const req = this.parse(body, ExecutorCreateRequestSchema);

    const values = { ...toInsertValues(req), secrets: sealApiKey(req) ?? null };
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
    // api_key tri-state (write-only): omitted → keep the stored blob;
    // string → replace; explicit null → clear (host subscription).
    const apiKey = req.type === 'claude_cli' ? req.api_key : undefined;
    const secretsPatch =
      apiKey === undefined ? {} : { secrets: apiKey === null ? null : sealExecutorSecrets({ api_key: apiKey }) };
    let rows: ExecutorRow[];
    try {
      rows = await this.db
        .update(schema.executors)
        .set({
          type: values.type,
          name: values.name,
          config: values.config,
          maxParallelRuns: values.maxParallelRuns,
          ...secretsPatch,
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

  private parse<T>(body: unknown, schemaDef: { safeParse: (b: unknown) => { success: boolean; data?: T; error?: { issues: { path: PropertyKey[]; message: string; code: string }[] } } }): T {
    const parsed = schemaDef.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'Executor could not be saved.',
        parsed.error!.issues.map((i) => ({ path: zodIssuePath(i.path), code: i.code, message: i.message, level: 'error' as const })),
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
    maxParallelRuns: req.max_parallel_runs,
    config,
  };
}

/** create-time api_key seal: string → sealed blob; absent/null → undefined (no key). */
function sealApiKey(req: ExecutorCreateRequest): Buffer | undefined {
  if (req.type !== 'claude_cli' || req.api_key == null) return undefined;
  return sealExecutorSecrets({ api_key: req.api_key });
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
    max_parallel_runs: row.maxParallelRuns,
    // The stored blob's PRESENCE is public; its content never is (write-only).
    has_api_key: row.secrets != null,
    config,
  };
}

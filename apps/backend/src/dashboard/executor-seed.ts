import { and, eq, sql } from 'drizzle-orm';
import { type BrigadirDb, schema, getRepositories } from '@brigadir/database';

/**
 * Default executor seeding (feature 006, executors-api.md "Default seeding" +
 * "Backfill"). Every workspace gets exactly one `claude_cli` "claude" and one
 * `mock` "mock" so the agent-form picker is never empty (SC-006, FR-022/FR-023).
 *
 * The stored `config` jsonb uses the SAME camelCase keys the executor runtime
 * already consumes (config-seeder + resolveClaudeCliConfig) — the API layer
 * translates snake_case ⇄ camelCase at the controller boundary, so seeding here
 * writes directly in the storage shape.
 */

/** Sensible defaults for the seeded claude_cli executor (executors-api.md). */
const CLAUDE_DEFAULTS = {
  // Cost-sane default (matches the live executor config); raise per-executor
  // via the config form when a workspace needs a heavier model.
  model: 'claude-sonnet-5',
  cliPath: 'claude',
  useCallbackChannel: true,
  keepFailedWorktrees: false,
  maxTurns: 40,
};
const DEFAULT_CONCURRENCY = 2;

export interface SeedExecutorRow {
  name: string;
  type: 'mock' | 'claude_cli';
  concurrencyLimit: number;
  config: Record<string, unknown>;
}

/** The `claude` default; `repository` = the workspace default repo when present, else empty. */
export function buildClaudeDefault(defaultRepository: string): SeedExecutorRow {
  return {
    name: 'claude',
    type: 'claude_cli',
    concurrencyLimit: DEFAULT_CONCURRENCY,
    config: { ...CLAUDE_DEFAULTS, repository: defaultRepository },
  };
}

/** The `mock` default (concurrency only). */
export function buildMockDefault(): SeedExecutorRow {
  return { name: 'mock', type: 'mock', concurrencyLimit: DEFAULT_CONCURRENCY, config: {} };
}

/**
 * Seed BOTH named defaults for a freshly-created workspace (insert-if-absent by
 * the `executors_workspace_name` unique index — a re-run is safe). Used from
 * `WorkspacesController.create`.
 */
export async function seedDefaultExecutors(
  db: BrigadirDb,
  workspaceId: string,
  defaultRepository: string,
): Promise<void> {
  const rows = [buildClaudeDefault(defaultRepository), buildMockDefault()];
  await db
    .insert(schema.executors)
    .values(rows.map((r) => ({ workspaceId, ...r })))
    .onConflictDoNothing({
      target: [schema.executors.workspaceId, schema.executors.name],
    });
}

/**
 * TYPE-scoped backfill for existing workspaces (executors-api.md "Backfill"): a
 * default of a type is inserted ONLY when the workspace has no executor of that
 * type at all. A workspace with custom-named executors (e.g. `claude-cli` /
 * `mock-exec`) gains nothing — no duplicate defaults, no inflated per-type
 * concurrency sum. Existing rows are never modified.
 */
export async function backfillDefaultExecutors(db: BrigadirDb): Promise<void> {
  const workspaces = await db.select({ id: schema.workspaces.id }).from(schema.workspaces);
  for (const ws of workspaces) {
    const repos = await getRepositories(db, ws.id);
    const defaultRepo = repos[0]?.name ?? '';
    const wanted: SeedExecutorRow[] = [buildClaudeDefault(defaultRepo), buildMockDefault()];
    for (const row of wanted) {
      const [existing] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.executors)
        .where(and(eq(schema.executors.workspaceId, ws.id), eq(schema.executors.type, row.type)));
      if ((existing?.count ?? 0) > 0) continue; // type already present → skip (type-scoped)
      await db
        .insert(schema.executors)
        .values({ workspaceId: ws.id, ...row })
        .onConflictDoNothing({ target: [schema.executors.workspaceId, schema.executors.name] });
    }
  }
}

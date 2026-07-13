import { eq, sql } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';

/**
 * Default executor backfill, PLATFORM-scoped (2026-07-13). Executors are
 * global capacity now, so workspace creation seeds nothing; instead one
 * type-scoped backfill at backend bootstrap guarantees the agent-form picker
 * is never empty: if no executor of a type exists AT ALL, that type's default
 * is inserted.
 *
 * The stored `config` jsonb uses the SAME camelCase keys the executor runtime
 * already consumes (config-seeder + resolveClaudeCliConfig) — the API layer
 * translates snake_case ⇄ camelCase at the controller boundary, so seeding here
 * writes directly in the storage shape. No `repository` key: a run's repository
 * resolves from `agents.behavior.repository`, else the run workspace's default.
 */

/** Sensible defaults for the seeded claude_cli executor. */
const CLAUDE_DEFAULTS = {
  // Cost-sane default (matches the live executor config); raise per-executor
  // via the config form when a heavier model is needed.
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
  maxParallelRuns: number;
  config: Record<string, unknown>;
}

/** The `claude` default. */
export function buildClaudeDefault(): SeedExecutorRow {
  return {
    name: 'claude',
    type: 'claude_cli',
    maxParallelRuns: DEFAULT_CONCURRENCY,
    config: { ...CLAUDE_DEFAULTS },
  };
}

/** The `mock` default (concurrency only). */
export function buildMockDefault(): SeedExecutorRow {
  return { name: 'mock', type: 'mock', maxParallelRuns: DEFAULT_CONCURRENCY, config: {} };
}

/**
 * TYPE-scoped global backfill: a default of a type is inserted ONLY when the
 * platform has no executor of that type at all. A DB with custom-named
 * executors (e.g. `claude-cli` / `mock-exec`) gains nothing — no duplicate
 * defaults, no inflated per-type concurrency sum. Existing rows are never
 * modified.
 */
export async function backfillDefaultExecutors(db: BrigadirDb): Promise<void> {
  const wanted: SeedExecutorRow[] = [buildClaudeDefault(), buildMockDefault()];
  for (const row of wanted) {
    const [existing] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.executors)
      .where(eq(schema.executors.type, row.type));
    if ((existing?.count ?? 0) > 0) continue; // type already present → skip (type-scoped)
    await db
      .insert(schema.executors)
      .values(row)
      .onConflictDoNothing({ target: [schema.executors.name] });
  }
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startDatabase, DbHarness } from './harness';

/**
 * T037/T038: migration 0001 (board columns) applies from scratch on a fresh
 * Postgres 16, adds jira_board_id/jira_board_type, and leaves all iteration-1
 * tables intact. `startDatabase()` applies every committed migration (0000+0001)
 * from zero, so reaching here already proves the chain applies.
 */
describe('migration 0001_jira_board (T037/T038)', () => {
  let h: DbHarness;

  beforeAll(async () => {
    h = await startDatabase();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('adds jira_board_id (integer) and jira_board_type (text) to workspaces', async () => {
    const rows = await h.db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workspaces'
        AND column_name IN ('jira_board_id', 'jira_board_type')
      ORDER BY column_name
    `);
    const byName = Object.fromEntries(
      rows.rows.map((r) => [r.column_name as string, r]),
    ) as Record<string, { data_type: string; is_nullable: string }>;

    expect(byName['jira_board_id']?.data_type).toBe('integer');
    expect(byName['jira_board_id']?.is_nullable).toBe('YES');
    expect(byName['jira_board_type']?.data_type).toBe('text');
    expect(byName['jira_board_type']?.is_nullable).toBe('YES');
  });

  it('leaves all 9 iteration-1 tables present', async () => {
    const rows = await h.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> '__drizzle_migrations'
    `);
    const names = rows.rows.map((r) => r.table_name as string).sort();
    expect(names).toEqual(
      [
        'agents',
        'executors',
        'human_tasks',
        'run_checks',
        'run_events',
        'runs',
        'tickets',
        'webhook_events',
        'workspaces',
      ].sort(),
    );
  });
});

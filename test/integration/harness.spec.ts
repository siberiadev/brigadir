import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startDatabase, DbHarness } from './harness';

const EXPECTED_TABLES = [
  'workspaces',
  'executors',
  'agents',
  'tickets',
  'runs',
  'run_checks',
  'run_events',
  'human_tasks',
  'webhook_events',
];

describe('DB harness — migrations apply from scratch (T013)', () => {
  let h: DbHarness;

  beforeAll(async () => {
    h = await startDatabase();
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('creates all 9 orchestration tables', async () => {
    const res = await h.db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tableNames = res.rows.map((r) => (r as { table_name: string }).table_name);
    for (const t of EXPECTED_TABLES) {
      expect(tableNames, `missing table ${t}`).toContain(t);
    }
  });
});

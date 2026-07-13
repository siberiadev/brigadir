import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { startDatabase, DbHarness } from './harness';

/**
 * Migration 0003 (platform-scoped executors): applies from scratch AND on a
 * database carrying real 0000–0002 data. `startDatabase()` proves the
 * from-scratch chain (0000→0003); the stepwise suite below replays the
 * pre-0003 world — two workspaces, colliding + unique executor names, an
 * agent reference — and asserts: rows kept, ids stable (agents.executor_id
 * needs no rewrite), collisions deterministically suffixed, workspace_id
 * gone, global unique index in force.
 */
const MIGRATIONS = ['0000_init.sql', '0001_jira_board.sql', '0002_runs_workspace_created.sql'];
const MIGRATION_0003 = '0003_platform_executors.sql';

function statementsOf(file: string): string[] {
  const text = readFileSync(join(process.cwd(), 'drizzle', file), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('migration 0003_platform_executors — from scratch', () => {
  let h: DbHarness;

  beforeAll(async () => {
    h = await startDatabase(); // applies the whole committed chain from zero
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('executors has no workspace_id and a global unique on name', async () => {
    const cols = await h.db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'executors'
    `);
    const names = cols.rows.map((r) => r.column_name as string).sort();
    expect(names).toEqual(['concurrency_limit', 'config', 'enabled', 'id', 'name', 'secrets', 'type']);

    const constraints = await h.db.execute(sql`
      SELECT conname FROM pg_constraint WHERE conrelid = 'executors'::regclass ORDER BY conname
    `);
    const conNames = constraints.rows.map((r) => r.conname as string);
    expect(conNames).toContain('executors_name');
    expect(conNames).not.toContain('executors_workspace_name');
    expect(conNames).not.toContain('executors_workspace_id_workspaces_id_fk');
  });

  it('agents.executor_id FK stays as-is', async () => {
    const fks = await h.db.execute(sql`
      SELECT conname FROM pg_constraint WHERE conrelid = 'agents'::regclass AND contype = 'f'
    `);
    expect(fks.rows.map((r) => r.conname as string)).toContain('agents_executor_id_executors_id_fk');
  });
});

describe('migration 0003_platform_executors — on a DB with existing 0000–0002 data', () => {
  let pool: Pool;
  let admin: Pool;
  let dbName: string;

  beforeAll(async () => {
    const adminUrl = inject('PG_ADMIN_URL');
    dbName = `test_mig0003_${randomBytes(4).toString('hex')}`;
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString() });

    for (const file of MIGRATIONS) {
      for (const stmt of statementsOf(file)) await pool.query(stmt);
    }
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it('keeps every row, preserves ids, and suffixes only the later name collision', async () => {
    // Two workspaces: the live-DB shape (ST3 MCP v3 with mock-exec/claude-cli)
    // plus a second workspace whose executor name COLLIDES with the first's.
    const ws = await pool.query(`
      INSERT INTO workspaces (name, jira_site_url, jira_project_key, jira_credentials)
      VALUES ('ST3 MCP v3', 'https://a.atlassian.net', 'ST3', 'x'::bytea),
             ('Other', 'https://b.atlassian.net', 'OTH', 'x'::bytea)
      RETURNING id
    `);
    const [wsA, wsB] = ws.rows.map((r) => r.id as string);

    const ex = await pool.query(
      `
      INSERT INTO executors (workspace_id, type, name, concurrency_limit, config)
      VALUES ($1, 'mock', 'mock-exec', 2, '{}'::jsonb),
             ($1, 'claude_cli', 'claude-cli', 1, '{"model":"claude-sonnet-5","repository":"legacy"}'::jsonb),
             ($2, 'mock', 'mock-exec', 3, '{}'::jsonb)
      RETURNING id, name, workspace_id
    `,
      [wsA, wsB],
    );
    const byName = new Map<string, { id: string; ws: string }[]>();
    for (const r of ex.rows) {
      const list = byName.get(r.name as string) ?? [];
      list.push({ id: r.id as string, ws: r.workspace_id as string });
      byName.set(r.name as string, list);
    }
    const idsBefore = new Set(ex.rows.map((r) => r.id as string));

    // An agent referencing the claude-cli executor — its FK must survive untouched.
    const claudeId = ex.rows.find((r) => r.name === 'claude-cli')!.id as string;
    await pool.query(
      `
      INSERT INTO agents (workspace_id, executor_id, name, instruction, status_success, status_failure)
      VALUES ($1, $2, 'implementer', 'x', 'Done', 'Blocked')
    `,
      [wsA, claudeId],
    );

    for (const stmt of statementsOf(MIGRATION_0003)) await pool.query(stmt);

    const after = await pool.query('SELECT id, name, type, concurrency_limit, config FROM executors ORDER BY name');
    expect(after.rows).toHaveLength(3);
    expect(new Set(after.rows.map((r) => r.id as string))).toEqual(idsBefore); // ids stable

    // Exactly one mock-exec keeps its bare name (the smaller id — deterministic);
    // the later duplicate is suffixed with its own 8-char id fragment.
    const mockRows = after.rows.filter((r) => (r.name as string).startsWith('mock-exec'));
    expect(mockRows).toHaveLength(2);
    const bare = mockRows.filter((r) => r.name === 'mock-exec');
    expect(bare).toHaveLength(1);
    const dupes = byName.get('mock-exec')!.map((e) => e.id).sort();
    expect(bare[0].id).toBe(dupes[0]); // the first by id order keeps the name
    const suffixed = mockRows.find((r) => r.name !== 'mock-exec')!;
    expect(suffixed.name).toBe(`mock-exec-${(suffixed.id as string).slice(0, 8)}`);

    // The uniquely-named executor is untouched, leftover repository key kept (ignored by the runtime).
    const claude = after.rows.find((r) => r.id === claudeId)!;
    expect(claude.name).toBe('claude-cli');
    expect(claude.config).toMatchObject({ model: 'claude-sonnet-5', repository: 'legacy' });

    // agents.executor_id needed no rewrite.
    const agents = await pool.query('SELECT executor_id FROM agents');
    expect(agents.rows[0].executor_id).toBe(claudeId);

    // workspace_id is gone; the global unique is enforced.
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'executors' AND column_name = 'workspace_id'`,
    );
    expect(cols.rows).toHaveLength(0);
    await expect(
      pool.query(`INSERT INTO executors (type, name) VALUES ('mock', 'mock-exec')`),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

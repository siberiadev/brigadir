import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { slugifyAgentKey, ensureUniqueAgentKey } from '@brigadir/contracts';
import { startDatabase, type DbHarness } from './harness';

/**
 * feature 014 (US4, T018): the migration backfill re-expresses slugifyAgentKey /
 * ensureUniqueAgentKey in SQL. This suite proves SQL↔TS parity by driving the
 * EXACT backfill statements from `drizzle/0007_agent_identity.sql` against a set
 * of pre-feature-shaped rows (orchestrator, slug collisions, a reserved-key
 * collision, a non-Latin name) and comparing every resulting key to what the TS
 * functions produce for the same inputs in the same (id) order.
 */
describe('feature 014 — migration backfill parity (T018)', () => {
  let db: DbHarness;
  let workspaceId: string;

  // The backfill statements (orchestrator UPDATE + the DO block), read straight
  // from the committed migration so this test can never drift from it.
  // The two data statements (orchestrator UPDATE, then the worker DO block),
  // identified by content since each chunk begins with a `--` comment. File order
  // is preserved so the orchestrator UPDATE still runs before the DO block.
  const backfillStatements = readFileSync(
    join(process.cwd(), 'drizzle', '0007_agent_identity.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.includes("'teamlead'") || s.includes('DO $$'));

  const workerNames = ['Hera Reviewer', 'QA Agent', 'qa agent', 'Brigadir', 'Ахиллес'];

  beforeAll(async () => {
    db = await startDatabase();

    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'backfill-ws',
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;

    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 2 })
      .returning({ id: schema.executors.id });

    // Seed rows with throwaway unique keys (key is NOT NULL post-migration), then
    // reset them to the PRE-feature state (key/role NULL) below.
    const seed = (name: string, i: number, isOrchestrator = false) => ({
      workspaceId,
      executorId: exec.id,
      name,
      key: `tmp-${i}`,
      isOrchestrator,
      instruction: 'x',
      statusSuccess: 'Done',
      statusFailure: 'Blocked',
    });
    await db.db.insert(schema.agents).values([
      seed('brigadir', 0, true),
      ...workerNames.map((n, i) => seed(n, i + 1)),
    ]);

    // Simulate the pre-0007 shape: drop NOT NULL (added by the migration) so we
    // can null key/role. (NULLs don't violate UNIQUE(workspace_id, key).)
    await db.db.execute(sql`ALTER TABLE agents ALTER COLUMN key DROP NOT NULL`);
    await db.db
      .update(schema.agents)
      .set({ key: null as unknown as string, role: null })
      .where(eq(schema.agents.workspaceId, workspaceId));

    // Run the REAL backfill SQL from the migration.
    for (const stmt of backfillStatements) {
      await db.db.execute(sql.raw(stmt));
    }
  }, 240_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('orchestrator → role "teamlead", key "brigadir" (keyed on the flag, not the name)', async () => {
    const [orch] = await db.db
      .select({ key: schema.agents.key, role: schema.agents.role })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.isOrchestrator, true)));
    expect(orch.key).toBe('brigadir');
    expect(orch.role).toBe('teamlead');
  });

  it('every worker key is byte-identical to the TS slug + suffix functions (SQL↔TS parity)', async () => {
    // Same order the DO block uses: workers, by id.
    const workers = await db.db
      .select({ id: schema.agents.id, name: schema.agents.name, key: schema.agents.key, role: schema.agents.role })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.isOrchestrator, false)))
      .orderBy(schema.agents.id);

    // TS reference: reserved keys are treated as taken by ensureUniqueAgentKey.
    const taken = new Set<string>();
    for (const w of workers) {
      const expectedKey = ensureUniqueAgentKey(slugifyAgentKey(w.name, null), taken);
      taken.add(expectedKey);
      expect(w.key, `key for "${w.name}"`).toBe(expectedKey);
      expect(w.role).toBeNull(); // workers backfill to NULL role
    }
  });

  it('produces non-empty, workspace-unique keys with the expected shapes', async () => {
    const rows = await db.db
      .select({ name: schema.agents.name, key: schema.agents.key })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId));
    const byName = new Map(rows.map((r) => [r.name, r.key]));

    expect(byName.get('Hera Reviewer')).toBe('hera-reviewer');
    // 'QA Agent' and 'qa agent' both slug to 'qa-agent' → first keeps it, second -2.
    const qaKeys = [byName.get('QA Agent'), byName.get('qa agent')].sort();
    expect(qaKeys).toEqual(['qa-agent', 'qa-agent-2']);
    // 'Brigadir' slugs to the reserved 'brigadir' → suffixed away from the orchestrator.
    expect(byName.get('Brigadir')).toBe('brigadir-2');
    // A non-Latin name slugs to empty → the generic stem.
    expect(byName.get('Ахиллес')).toBe('agent');

    const keys = rows.map((r) => r.key);
    expect(keys.every((k) => k && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // unique within the workspace
  });

  it('the pre-feature UNIQUE(workspace_id, name) constraint is gone; UNIQUE(workspace_id, key) exists', async () => {
    const { rows } = await db.db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conrelid = 'agents'::regclass AND contype = 'u'`,
    );
    const names = rows.map((r) => r.conname as string);
    expect(names).not.toContain('agents_workspace_name');
    expect(names).toContain('agents_workspace_key');
  });
});

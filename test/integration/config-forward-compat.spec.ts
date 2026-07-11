import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { schema, getWorkspaceSettings } from '@brigadir/database';
import { loadAgentsConfig, ConfigSeeder, AppConfigModule } from '@brigadir/app-config';
import { startDatabase, DbHarness } from './harness';
import { join } from 'node:path';

/**
 * T041 (FR-039): the full documented docs/spec.md §0.1 workspace example —
 * board_id, scope_jql, branch_prefix, repositories[] — passes fail-fast startup
 * validation and seeds, with the validated-but-unused keys neither rejected nor
 * required. board_id + scope_jql are functional this iteration (SC-011 config half).
 */
const FULL_EXAMPLE = join(process.cwd(), 'test', 'fixtures', 'agents.full-example.yaml');

describe('config forward-compatibility (T041 / FR-039)', () => {
  let h: DbHarness;

  beforeAll(async () => {
    h = await startDatabase();
    process.env.DATABASE_URL = h.url;
    process.env.AGENTS_CONFIG_PATH = FULL_EXAMPLE;
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('validates the full documented example (no unknown-key rejection)', () => {
    const cfg = loadAgentsConfig(FULL_EXAMPLE);
    expect(cfg.workspace.board_id).toBe(42);
    expect(cfg.workspace.scope_jql).toBe('labels = ai-pipeline');
    // forward-compat keys parsed, not required elsewhere
    expect(cfg.workspace.branch_prefix).toBe('feat');
    expect(cfg.workspace.repositories).toHaveLength(2);
    expect(cfg.workspace.repositories?.[0]).toMatchObject({ name: 'product', default_branch: 'main' });
  });

  it('boots + seeds: board_id → column, scope_jql → settings', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
    const { workspaceId } = await moduleRef.get(ConfigSeeder).seed();
    await moduleRef.close();

    const [ws] = await h.db.select().from(schema.workspaces);
    expect(ws.jiraBoardId).toBe(42);

    const settings = await getWorkspaceSettings(h.db, workspaceId);
    expect(settings.scope_jql).toBe('labels = ai-pipeline');
    expect(settings.branch_prefix).toBe('feat'); // persisted, inert this iteration
  });
});

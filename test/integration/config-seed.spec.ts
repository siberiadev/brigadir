import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { schema } from '@brigadir/database';
import { ConfigSeeder, AppConfigModule } from '@brigadir/app-config';
import { startDatabase, DbHarness } from './harness';
import { join } from 'node:path';

/**
 * T017: boot with a valid config → workspace/executors/agents seeded; boot a
 * second time → no duplicate rows (idempotent seed).
 */
describe('config → DB seeder (T017)', () => {
  let h: DbHarness;

  beforeAll(async () => {
    h = await startDatabase();
    process.env.DATABASE_URL = h.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function seedOnce(): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule],
    }).compile();
    await moduleRef.get(ConfigSeeder).seed();
    await moduleRef.close();
  }

  it('seeds workspace + executors + agents from the valid config', async () => {
    await seedOnce();

    const workspaces = await h.db.select().from(schema.workspaces);
    const executors = await h.db.select().from(schema.executors);
    const agents = await h.db.select().from(schema.agents);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].jiraProjectKey).toBe('BRIG');
    expect(workspaces[0].jiraBoardId).toBe(42); // T040: board_id → column
    expect(workspaces[0].jiraBoardType).toBeNull(); // populated later by introspection (T049)
    expect(executors).toHaveLength(1);
    expect(executors[0].name).toBe('mock-exec');
    expect(executors[0].type).toBe('mock');
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('implementer');
    expect(agents[0].executorId).toBe(executors[0].id);
  });

  it('is idempotent — a second boot leaves exactly one row set', async () => {
    await seedOnce();

    const workspaces = await h.db.select().from(schema.workspaces);
    const executors = await h.db.select().from(schema.executors);
    const agents = await h.db.select().from(schema.agents);

    expect(workspaces).toHaveLength(1);
    expect(executors).toHaveLength(1);
    expect(agents).toHaveLength(1);

    // still correctly linked
    const [agent] = agents;
    const linked = await h.db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.id, agent.executorId));
    expect(linked).toHaveLength(1);
  });
});

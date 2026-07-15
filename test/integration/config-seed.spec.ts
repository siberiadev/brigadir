import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { schema, ORCHESTRATOR_AGENT_NAME, ORCHESTRATOR_EXECUTOR_NAME } from '@brigadir/database';
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
    // The yaml executor/agent, plus the feature-010 orchestrator + its own cheap
    // no-repo executor profile.
    expect(executors).toHaveLength(2);
    const mockExec = executors.find((e) => e.name === 'mock-exec');
    expect(mockExec?.type).toBe('mock');
    expect(executors.some((e) => e.name === ORCHESTRATOR_EXECUTOR_NAME)).toBe(true);
    expect(agents).toHaveLength(2);
    const impl = agents.find((a) => a.name === 'implementer');
    expect(impl?.executorId).toBe(mockExec?.id);
    expect(agents.some((a) => a.name === ORCHESTRATOR_AGENT_NAME && a.isOrchestrator)).toBe(true);
  });

  it('is idempotent — a second boot leaves exactly one row set', async () => {
    await seedOnce();

    const workspaces = await h.db.select().from(schema.workspaces);
    const executors = await h.db.select().from(schema.executors);
    const agents = await h.db.select().from(schema.agents);

    // Idempotent: the yaml rows + the orchestrator rows, and a second boot adds
    // nothing (2, not 4).
    expect(workspaces).toHaveLength(1);
    expect(executors).toHaveLength(2);
    expect(agents).toHaveLength(2);

    // still correctly linked
    const agent = agents.find((a) => a.name === 'implementer')!;
    const linked = await h.db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.id, agent.executorId));
    expect(linked).toHaveLength(1);
  });
});

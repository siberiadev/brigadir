import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';

/**
 * T009 (US4, FR-024/SC-009): DELETE an unreferenced executor → 204; DELETE an
 * executor referenced by agents → 409 `executor_in_use` naming the agents, with
 * no orphaned references (the executor row stays).
 */
describe('executor delete guard (T009)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let workspaceId: string;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(async () => {
    await db.db.delete(schema.workspaces);
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws.id;
  });

  const seedExecutor = async (name: string) => {
    const [row] = await db.db
      .insert(schema.executors)
      .values({ workspaceId, type: 'mock', name, concurrencyLimit: 1, config: {} })
      .returning({ id: schema.executors.id });
    return row.id;
  };

  const seedAgent = async (executorId: string, name: string) => {
    await db.db.insert(schema.agents).values({
      workspaceId,
      executorId,
      name,
      instruction: 'x',
      statusSuccess: 'Done',
      statusFailure: 'Blocked',
    });
  };

  it('DELETE an unreferenced executor → 204', async () => {
    const id = await seedExecutor('lonely');
    const res = await fetch(`${url}/api/workspaces/${workspaceId}/executors/${id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(204);
    const rows = await db.db.select().from(schema.executors).where(eq(schema.executors.id, id));
    expect(rows).toHaveLength(0);
  });

  it('DELETE a referenced executor → 409 executor_in_use naming the agents; the row survives', async () => {
    const id = await seedExecutor('used');
    await seedAgent(id, 'reviewer');
    await seedAgent(id, 'migrator');

    const res = await fetch(`${url}/api/workspaces/${workspaceId}/executors/${id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('executor_in_use');
    expect(body.error.message).toContain('reviewer');
    expect(body.error.message).toContain('migrator');

    // no orphaned refs — the executor row is still there
    const rows = await db.db.select().from(schema.executors).where(eq(schema.executors.id, id));
    expect(rows).toHaveLength(1);
  });
});

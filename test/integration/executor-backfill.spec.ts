import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { ExecutorBackfillService } from '../../apps/backend/src/dashboard/executor-backfill.service';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';

/**
 * T010 (US4): the `OnApplicationBootstrap` backfill is TYPE-scoped. A pre-006
 * workspace with zero executors gets both defaults; a workspace with a
 * custom-named executor of a type gains no duplicate for that type; existing
 * rows are never modified.
 */
describe('executor type-scoped backfill (T010)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let backfill: ExecutorBackfillService;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    backfill = app.get(ExecutorBackfillService, { strict: false });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(async () => {
    await db.db.delete(schema.workspaces);
  });

  const insertWorkspace = async (name: string) => {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name,
        jiraSiteUrl: 'https://test.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  };

  const executorsOf = (wsId: string) =>
    db.db.select().from(schema.executors).where(eq(schema.executors.workspaceId, wsId));

  it('a pre-006 workspace with zero executors gets both type defaults', async () => {
    const wsId = await insertWorkspace('empty');
    await backfill.run();
    const rows = await executorsOf(wsId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type).sort()).toEqual(['claude_cli', 'mock']);
    expect(rows.map((r) => r.name).sort()).toEqual(['claude', 'mock']);
  });

  it('a workspace with a custom-named executor of a type gains no duplicate for that type, only the missing type', async () => {
    const wsId = await insertWorkspace('custom');
    await db.db
      .insert(schema.executors)
      .values({ workspaceId: wsId, type: 'claude_cli', name: 'claude-cli', concurrencyLimit: 7, config: { model: 'x' } });

    await backfill.run();
    const rows = await executorsOf(wsId);
    // one claude_cli (the custom one, untouched) + one seeded mock default
    const claude = rows.filter((r) => r.type === 'claude_cli');
    const mock = rows.filter((r) => r.type === 'mock');
    expect(claude).toHaveLength(1);
    expect(claude[0].name).toBe('claude-cli');
    expect(claude[0].concurrencyLimit).toBe(7); // existing row unmodified
    expect(mock).toHaveLength(1);
    expect(mock[0].name).toBe('mock');
  });

  it('is idempotent — a second run inserts nothing new', async () => {
    const wsId = await insertWorkspace('idem');
    await backfill.run();
    const first = await executorsOf(wsId);
    await backfill.run();
    const second = await executorsOf(wsId);
    expect(second).toHaveLength(first.length);
  });
});

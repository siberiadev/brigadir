import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { ExecutorBackfillService } from '../../apps/backend/src/dashboard/executor-backfill.service';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';

/**
 * The `OnApplicationBootstrap` backfill is GLOBAL and TYPE-scoped
 * (platform-scoped executors, 2026-07-13): an empty DB gets both type
 * defaults; a DB that already has a custom-named executor of a type gains no
 * duplicate of that type; existing rows are never modified.
 */
describe('executor global type-scoped backfill', () => {
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
    await db.db.delete(schema.agents);
    await db.db.delete(schema.executors);
  });

  const allExecutors = () => db.db.select().from(schema.executors);

  it('an empty DB gets both type defaults (claude_cli "claude" + mock "mock", no repository in config)', async () => {
    await backfill.run();
    const rows = await allExecutors();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type).sort()).toEqual(['claude_cli', 'mock']);
    expect(rows.map((r) => r.name).sort()).toEqual(['claude', 'mock']);

    const claude = rows.find((r) => r.type === 'claude_cli')!;
    expect(claude.concurrencyLimit).toBe(2);
    expect(claude.config).toMatchObject({
      model: 'claude-sonnet-5',
      cliPath: 'claude',
      useCallbackChannel: true,
      keepFailedWorktrees: false,
      maxTurns: 40,
    });
    expect((claude.config as Record<string, unknown>).repository).toBeUndefined();
  });

  it('a DB with a custom-named executor of a type gains no duplicate of that type, only the missing type', async () => {
    await db.db
      .insert(schema.executors)
      .values({ type: 'claude_cli', name: 'claude-cli', concurrencyLimit: 7, config: { model: 'x' } });

    await backfill.run();
    const rows = await allExecutors();
    // one claude_cli (the custom one, untouched) + one seeded mock default
    const claude = rows.filter((r) => r.type === 'claude_cli');
    const mock = rows.filter((r) => r.type === 'mock');
    expect(claude).toHaveLength(1);
    expect(claude[0].name).toBe('claude-cli');
    expect(claude[0].concurrencyLimit).toBe(7); // existing row unmodified
    expect(mock).toHaveLength(1);
    expect(mock[0].name).toBe('mock');
  });

  it('mirrors the live DB: "mock-exec" + "claude-cli" present → backfill adds NOTHING', async () => {
    await db.db.insert(schema.executors).values([
      { type: 'mock', name: 'mock-exec', concurrencyLimit: 2, config: {} },
      // the leftover repository key in a pre-0003 config is kept and ignored
      { type: 'claude_cli', name: 'claude-cli', concurrencyLimit: 1, config: { model: 'x', repository: 'old' } },
    ]);
    await backfill.run();
    const rows = await allExecutors();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['claude-cli', 'mock-exec']);
  });

  it('is idempotent — a second run inserts nothing new', async () => {
    await backfill.run();
    const first = await allExecutors();
    await backfill.run();
    const second = await allExecutors();
    expect(second).toHaveLength(first.length);
  });
});

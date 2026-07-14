import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import { ConfigSeeder, AppConfigModule } from '@brigadir/app-config';
import { QueuesModule, runQueueName, RECONCILE_QUEUE } from '@brigadir/queues';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';

const VALID_YAML = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
const ABSENT_YAML = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');

/**
 * T130 (mandatory — DB-vs-yaml boot matrix, task (c); SC-005/007): (a) empty DB +
 * yaml → imported once; (b) DB rows differing from yaml survive boot unchanged
 * (DB wins, FR-017); (c) yaml absent → boot succeeds on DB config (FR-019); (d)
 * the run-queue set == the RUN_QUEUE_EXECUTOR_TYPES registry regardless of yaml.
 */
describe('config source-of-truth flip (T130)', () => {
  let db: DbHarness;
  let redis: RedisHarness;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
  }, 240_000);

  afterAll(async () => {
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(async () => {
    await db.db.delete(schema.workspaces); // cascades agents
    await db.db.delete(schema.executors); // platform-scoped — no longer cascades from workspaces
  });

  async function seedWithYaml(path: string): Promise<void> {
    process.env.AGENTS_CONFIG_PATH = path;
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppConfigModule],
    }).compile();
    await moduleRef.get(ConfigSeeder).seed();
    await moduleRef.close();
  }

  it('(a) empty DB + yaml present → rows imported exactly once (idempotent)', async () => {
    await seedWithYaml(VALID_YAML);
    await seedWithYaml(VALID_YAML); // second boot

    expect(await db.db.select().from(schema.workspaces)).toHaveLength(1);
    expect(await db.db.select().from(schema.executors)).toHaveLength(1);
    expect(await db.db.select().from(schema.agents)).toHaveLength(1);
  });

  it('(b) DB rows differing from yaml survive the boot unchanged (DB wins)', async () => {
    // Pre-seed a workspace/executor/agent named as the yaml would, but with
    // DIFFERENT values (the operator edited them via the UI).
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'BRIG', // yaml derives workspace name from project_key
        jiraSiteUrl: 'https://edited-by-ui.atlassian.net',
        jiraProjectKey: 'BRIG',
        jiraBoardId: 999,
        jiraCredentials: Buffer.from('placeholder'),
      })
      .returning({ id: schema.workspaces.id });
    const [exec] = await db.db
      .insert(schema.executors)
      .values({ type: 'mock', name: 'mock-exec', maxParallelRuns: 7 })
      .returning({ id: schema.executors.id });
    await db.db.insert(schema.agents).values({
      workspaceId: ws.id,
      executorId: exec.id,
      name: 'implementer',
      instruction: 'EDITED VIA UI — must not be overwritten',
      statusSuccess: 'Shipped',
      statusFailure: 'Rejected',
    });

    await seedWithYaml(VALID_YAML);

    const [wsAfter] = await db.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ws.id));
    expect(wsAfter.jiraSiteUrl).toBe('https://edited-by-ui.atlassian.net'); // DB wins
    expect(wsAfter.jiraBoardId).toBe(999);

    const [execAfter] = await db.db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.id, exec.id));
    expect(execAfter.maxParallelRuns).toBe(7); // DB wins

    const [agentAfter] = await db.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, ws.id), eq(schema.agents.name, 'implementer')));
    expect(agentAfter.instruction).toBe('EDITED VIA UI — must not be overwritten'); // DB wins
    expect(agentAfter.statusSuccess).toBe('Shipped');

    // still exactly one row set (no duplicate insert)
    expect(await db.db.select().from(schema.agents)).toHaveLength(1);
  });

  it('(c) yaml absent → the backend boots on DB-only config', async () => {
    process.env.AGENTS_CONFIG_PATH = ABSENT_YAML;
    const moduleRef = await Test.createTestingModule({
      imports: [BackendAppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.toBeDefined();
    await app.close();
  });

  it('(d) the run-queue set equals the registry, independent of yaml/agents', async () => {
    process.env.AGENTS_CONFIG_PATH = ABSENT_YAML; // no yaml at all
    const moduleRef = await Test.createTestingModule({
      imports: [QueuesModule.register()],
    }).compile();

    const mock = moduleRef.get<Queue>(getQueueToken(runQueueName('mock')), { strict: false });
    const claude = moduleRef.get<Queue>(getQueueToken(runQueueName('claude_cli')), { strict: false });
    const reconcile = moduleRef.get<Queue>(getQueueToken(RECONCILE_QUEUE), { strict: false });

    expect(mock.name).toBe('run.mock');
    expect(claude.name).toBe('run.claude_cli');
    expect(reconcile.name).toBe('reconcile');

    await moduleRef.close();
  });
});

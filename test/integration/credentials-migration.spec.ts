import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { join } from 'node:path';
import { schema } from '@brigadir/database';
import {
  migrateLegacyCredentials,
  encodeJiraCredentials,
  JIRA_CLIENT,
  type JiraClient,
} from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * T125 (focused migration function) + T126 (mandatory legacy-migration E2E, task
 * (b)): a plaintext credentials blob is re-encrypted to the AES-256-GCM `0x01`
 * envelope on boot, the system still authenticates by decrypting it, an
 * already-encrypted row is left byte-identical (idempotent), and with the key
 * unset the backend fails to boot (fail-fast, FR-023) — never a plaintext regime.
 */
describe('credentials boot migration (T125/T126)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let jira: MockJira;

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'agents.valid.yaml');
    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });
  }, 240_000);

  afterAll(async () => {
    jira?.server.close();
    await db?.stop();
    await redis?.stop();
  });

  beforeEach(async () => {
    jira.reset();
    await db.db.delete(schema.workspaces);
  });

  async function seedWorkspace(credentials: Buffer): Promise<string> {
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: `ws-${Math.random().toString(36).slice(2)}`,
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraCredentials: credentials,
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  }

  it('flips a plaintext row to 0x01 and leaves an already-encrypted row byte-identical', async () => {
    const plaintext = Buffer.from(JSON.stringify({ email: 'bot@acme.io', api_token: 'tok' }), 'utf8');
    const alreadyEncrypted = encodeJiraCredentials({ email: 'enc@acme.io', api_token: 'tok2' });
    const legacyId = await seedWorkspace(plaintext);
    const encId = await seedWorkspace(alreadyEncrypted);

    const migrated = await migrateLegacyCredentials(db.db);
    expect(migrated).toBe(1);

    const [legacyRow] = await db.db
      .select({ c: schema.workspaces.jiraCredentials })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, legacyId));
    const legacyBytes = Buffer.from(legacyRow.c as Buffer);
    expect(legacyBytes[0]).toBe(0x01);
    expect(legacyBytes.toString('utf8').includes('bot@acme.io')).toBe(false);

    const [encRow] = await db.db
      .select({ c: schema.workspaces.jiraCredentials })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, encId));
    expect(Buffer.from(encRow.c as Buffer).equals(alreadyEncrypted)).toBe(true);

    // A second pass is a no-op (idempotent).
    expect(await migrateLegacyCredentials(db.db)).toBe(0);
  });

  it('E2E: a plaintext workspace migrates on boot and still authenticates to Jira', async () => {
    const plaintext = Buffer.from(JSON.stringify({ email: 'bot@acme.io', api_token: 'tok' }), 'utf8');
    const wsId = await seedWorkspace(plaintext);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [BackendAppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      // The boot migration runs in main.api bootstrap; drive it explicitly here
      // against the same context, then prove the stored bytes are enveloped.
      await migrateLegacyCredentials(db.db);
      const [row] = await db.db
        .select({ c: schema.workspaces.jiraCredentials })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, wsId));
      expect(Buffer.from(row.c as Buffer)[0]).toBe(0x01);

      // The system authenticates by decrypting the migrated bytes.
      const client = app.get<JiraClient>(JIRA_CLIENT);
      const board = await client.getBoard(42);
      expect(board.projectKey).toBe('BRIG');
    } finally {
      await app.close();
    }
  });

  it('fails to boot with BRIGADIR_CREDENTIALS_KEY unset (fail-fast, FR-023)', async () => {
    const saved = process.env.BRIGADIR_CREDENTIALS_KEY;
    delete process.env.BRIGADIR_CREDENTIALS_KEY;
    try {
      await expect(
        (async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [BackendAppModule],
          }).compile();
          const app = moduleRef.createNestApplication();
          await app.init();
          await app.close();
        })(),
      ).rejects.toThrow(/BRIGADIR_CREDENTIALS_KEY/);
    } finally {
      process.env.BRIGADIR_CREDENTIALS_KEY = saved;
    }
  });
});

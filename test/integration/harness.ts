import { inject } from 'vitest';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Redis from 'ioredis';
import { runMigrations, schema } from '@brigadir/database';

// Containers are shared across the whole run (global-setup.ts); suites get
// logical isolation instead: a fresh CREATE DATABASE per suite on the shared
// Postgres, and a fresh Redis logical DB (SELECT n, flushed) per suite.
// Public signatures are unchanged — suites keep calling startDatabase/startRedis.

export interface DbHarness {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  url: string;
  stop: () => Promise<void>;
}

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

/** Create a fresh database on the shared Postgres, apply committed migrations from scratch. */
export async function startDatabase(): Promise<DbHarness> {
  const adminUrl = inject('PG_ADMIN_URL');
  const dbName = `test_${randomBytes(6).toString('hex')}`;

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const dbUrl = url.toString();

  process.env.DRIZZLE_MIGRATIONS_DIR = MIGRATIONS_DIR;
  await runMigrations(dbUrl);

  const pool = new Pool({ connectionString: dbUrl });
  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    url: dbUrl,
    stop: async () => {
      // The throwaway database dies with the shared container at run end;
      // dropping it here would require kicking out lingering app connections.
      await pool.end();
    },
  };
}

export interface RedisHarness {
  url: string;
  stop: () => Promise<void>;
}

/** Reserve a fresh logical DB (SELECT n) on the shared Redis and flush it. */
export async function startRedis(): Promise<RedisHarness> {
  const baseUrl = inject('REDIS_BASE_URL');

  const client = new Redis(baseUrl);
  // Atomic round-robin over logical DBs 1..15 (0 stays untouched as the counter home).
  const n = await client.incr('brigadir:test:db-counter');
  const dbIndex = (n % 15) + 1;
  await client.select(dbIndex);
  await client.flushdb();
  await client.quit();

  const url = new URL(baseUrl);
  url.pathname = `/${dbIndex}`;

  return {
    url: url.toString(),
    stop: async () => {
      /* shared container — nothing to stop per suite */
    },
  };
}

// ---- fixture seeders (return generated ids) ----

export interface SeededPipeline {
  workspaceId: string;
  executorId: string;
  agentId: string;
  ticketId: string;
}

export async function seedPipeline(
  db: NodePgDatabase<typeof schema>,
  opts: { maxAttempts?: number; executorType?: string } = {},
): Promise<SeededPipeline> {
  const [workspace] = await db
    .insert(schema.workspaces)
    .values({
      name: 'test-ws',
      jiraSiteUrl: 'https://test.atlassian.net',
      jiraProjectKey: 'BRIG',
      jiraCredentials: Buffer.from('placeholder'),
    })
    .returning({ id: schema.workspaces.id });

  const [executor] = await db
    .insert(schema.executors)
    .values({
      workspaceId: workspace.id,
      type: opts.executorType ?? 'mock',
      name: 'mock-exec',
      concurrencyLimit: 2,
    })
    .returning({ id: schema.executors.id });

  const [agent] = await db
    .insert(schema.agents)
    .values({
      workspaceId: workspace.id,
      executorId: executor.id,
      name: 'implementer',
      instruction: 'Implement the ticket.',
      statusSuccess: 'Code Review',
      statusFailure: 'Blocked',
      maxAttempts: opts.maxAttempts ?? 2,
    })
    .returning({ id: schema.agents.id });

  const [ticket] = await db
    .insert(schema.tickets)
    .values({
      workspaceId: workspace.id,
      jiraKey: 'BRIG-1',
      jiraId: '10001',
      summary: 'Test ticket',
    })
    .returning({ id: schema.tickets.id });

  return {
    workspaceId: workspace.id,
    executorId: executor.id,
    agentId: agent.id,
    ticketId: ticket.id,
  };
}

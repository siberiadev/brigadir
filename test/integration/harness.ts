import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { join } from 'node:path';
import { runMigrations, schema } from '@brigadir/database';

export interface DbHarness {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  url: string;
  stop: () => Promise<void>;
}

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

/** Boot a Postgres 16 container, apply committed migrations from scratch, return a Drizzle client. */
export async function startDatabase(): Promise<DbHarness> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();

  process.env.DRIZZLE_MIGRATIONS_DIR = MIGRATIONS_DIR;
  await runMigrations(url);

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  return {
    container,
    pool,
    db,
    url,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

export interface RedisHarness {
  container: StartedRedisContainer;
  url: string;
  stop: () => Promise<void>;
}

/** Boot a Redis 7 container (used by queue-facing suites in later phases). */
export async function startRedis(): Promise<RedisHarness> {
  const container = await new RedisContainer('redis:7-alpine').start();
  const url = container.getConnectionUrl();
  return {
    container,
    url,
    stop: async () => {
      await container.stop();
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

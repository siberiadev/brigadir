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

/**
 * Feature 004: BRIGADIR_JWT_SECRET is a hard boot-time requirement for both
 * BackendAppModule (RunTokenGuard) and WorkerAppModule (ClaudeCliRunProcessor
 * minting run tokens) — no silent default in production code (Constitution
 * lazy resolution). Every integration suite calls startDatabase() in its
 * beforeAll, so this is the one place a fixed test value is supplied,
 * mirroring how DATABASE_URL/REDIS_URL are already suite-scoped here rather
 * than touching each of the ~26 spec files individually.
 */
function ensureTestJwtSecret(): void {
  if (!process.env.BRIGADIR_JWT_SECRET) {
    process.env.BRIGADIR_JWT_SECRET = 'test-integration-jwt-secret-not-for-prod';
  }
}

/**
 * Feature 005: BRIGADIR_CREDENTIALS_KEY is a hard boot requirement for both
 * apps (AES-256-GCM credentials at rest, FR-023) — same posture as
 * BRIGADIR_JWT_SECRET. Supply one fixed 32-byte test key here (one place), so
 * every suite that boots BackendAppModule/WorkerAppModule resolves it at boot.
 */
function ensureTestCredentialsKey(): void {
  if (!process.env.BRIGADIR_CREDENTIALS_KEY) {
    // 32 bytes, base64 (deterministic, test-only).
    process.env.BRIGADIR_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  }
}

/**
 * Feature 005: BRIGADIR_DASHBOARD_TOKEN is boot-required by the backend (the
 * DashboardModule guard provider is fail-fast). Every suite that boots
 * BackendAppModule needs it, so it is supplied here in one place.
 */
export const TEST_DASHBOARD_TOKEN = 'test-integration-dashboard-token';
function ensureTestDashboardToken(): void {
  if (!process.env.BRIGADIR_DASHBOARD_TOKEN) {
    process.env.BRIGADIR_DASHBOARD_TOKEN = TEST_DASHBOARD_TOKEN;
  }
}

/** Create a fresh database on the shared Postgres, apply committed migrations from scratch. */
export async function startDatabase(): Promise<DbHarness> {
  ensureTestJwtSecret();
  ensureTestCredentialsKey();
  ensureTestDashboardToken();
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

/** Reserve a logical DB (SELECT n) on the shared Redis + a unique BullMQ prefix. */
export async function startRedis(): Promise<RedisHarness> {
  const baseUrl = inject('REDIS_BASE_URL');

  const client = new Redis(baseUrl);
  // Atomic round-robin over logical DBs 1..15 (0 stays untouched as the counter home).
  const n = await client.incr('brigadir:test:db-counter');
  const dbIndex = (n % 15) + 1;
  await client.quit();

  // With 37+ suites over 15 logical DBs, two CONCURRENT suites can share a DB.
  // Isolation therefore comes from a per-suite-unique BullMQ key prefix (the
  // counter value is unique for the whole run), read lazily by
  // QueuesModule.forRootAsync. This is also why there is NO flushdb here:
  // the container is fresh per run (global-setup), so there are no stale keys,
  // and flushing a shared DB nuked a live co-tenant's bull keys mid-suite —
  // its queued jobs vanished and runs hung at `queued` (found at the
  // iteration-4 checkpoint under full-suite load).
  process.env.BULLMQ_PREFIX = `bull-t${n}`;

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
  opts: {
    maxAttempts?: number;
    executorType?: string;
    /** Merged into `executors.config` (jsonb) — the claude_cli instance config (T083). */
    executorConfig?: Record<string, unknown>;
    /** Merged into `agents.behavior` (jsonb) — e.g. allowed_tools, branch_prefix. */
    behavior?: Record<string, unknown>;
    maxBudgetUsd?: number;
    timeoutMinutes?: number;
    ticketKey?: string;
    /** Feature 004: point at a mockJira() baseUrl so PipelineService/HumanTaskService Jira writes actually land. */
    jiraSiteUrl?: string;
    /** Feature 004: real `encodeJiraCredentials(...)` bytes — required alongside jiraSiteUrl for a working LazyJiraClient. */
    jiraCredentials?: Buffer;
    /** Feature 004: agent.status_running, for resume/onRunStarted transition assertions. */
    statusRunning?: string;
    /** Merged into `workspaces.settings` (jsonb) — e.g. repositories for claude_cli repo resolution. */
    workspaceSettings?: Record<string, unknown>;
  } = {},
): Promise<SeededPipeline> {
  const [workspace] = await db
    .insert(schema.workspaces)
    .values({
      name: 'test-ws',
      jiraSiteUrl: opts.jiraSiteUrl ?? 'https://test.atlassian.net',
      jiraProjectKey: 'BRIG',
      jiraCredentials: opts.jiraCredentials ?? Buffer.from('placeholder'),
      ...(opts.workspaceSettings ? { settings: opts.workspaceSettings } : {}),
    })
    .returning({ id: schema.workspaces.id });

  const [executor] = await db
    .insert(schema.executors)
    .values({
      // Executors are PLATFORM-scoped (migration 0003) with a GLOBAL unique
      // name; seedPipeline runs many times per suite database, so each call
      // mints a unique name (no spec asserts it — they assert type/config).
      type: opts.executorType ?? 'mock',
      name: `exec-${randomBytes(4).toString('hex')}`,
      maxParallelRuns: 2,
      config: opts.executorConfig ?? {},
    })
    .returning({ id: schema.executors.id });

  const [agent] = await db
    .insert(schema.agents)
    .values({
      workspaceId: workspace.id,
      executorId: executor.id,
      name: 'implementer',
      key: 'implementer',
      instruction: 'Implement the ticket.',
      statusRunning: opts.statusRunning ?? null,
      statusSuccess: 'Code Review',
      statusFailure: 'Blocked',
      maxAttempts: opts.maxAttempts ?? 2,
      behavior: opts.behavior ?? {},
      maxBudgetUsd: opts.maxBudgetUsd !== undefined ? String(opts.maxBudgetUsd) : null,
      timeoutMinutes: opts.timeoutMinutes ?? 45,
    })
    .returning({ id: schema.agents.id });

  const [ticket] = await db
    .insert(schema.tickets)
    .values({
      workspaceId: workspace.id,
      jiraKey: opts.ticketKey ?? 'BRIG-1',
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

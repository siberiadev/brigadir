import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

/**
 * Apply the committed SQL migrations under drizzle/ against DATABASE_URL.
 * Invoked from backend bootstrap before /health reports ok (T012), and by
 * the integration test harness (T013) against a fresh testcontainer.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    // migrations folder resolved relative to repo root
    const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR ?? join(process.cwd(), 'drizzle');
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres `bytea` — Drizzle has no built-in bytea column, so we define one.
 * Used for encrypted credential columns (architecture §3: workspaces.jira_credentials,
 * executors.secrets). Iteration 1 stores placeholder bytes; real encryption arrives
 * in iteration 2.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

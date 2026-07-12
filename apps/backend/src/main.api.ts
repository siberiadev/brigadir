import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { runMigrations, DRIZZLE, type BrigadirDb } from '@brigadir/database';
import { loadAgentsConfig, ConfigSeeder } from '@brigadir/app-config';
import { migrateLegacyCredentials, BRIGADIR_CREDENTIALS_KEY } from '@brigadir/jira';
import { BackendAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('backend');

  // 1. Fail-fast config validation BEFORE anything else — no DB required. An
  //    absent agents.yaml is OK now (DB-authoritative, FR-019 → null); a
  //    present-but-broken yaml still aborts with a path-qualified error and no
  //    partial boot (T015 / T128 / FR-013).
  const config = loadAgentsConfig();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  // 2. Apply committed migrations before the app (and /health) come up (T012).
  await runMigrations(databaseUrl);

  const app = await NestFactory.create(BackendAppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  // 3. Seed workspace/executors/agents from the validated yaml (T017),
  //    insert-if-absent (DB wins, FR-017) — only when a yaml actually loaded.
  if (config) {
    await app.get(ConfigSeeder).seed();
  }

  // 4. Legacy-credentials boot migration (feature 005, T125/FR-022): re-encrypt
  //    any plaintext `jira_credentials` blob into the AES-256-GCM envelope. The
  //    key is boot-required (JiraModule provider), so this always runs; a `0x01`
  //    row is skipped by the version-byte sniff (idempotent).
  const key = app.get<Buffer>(BRIGADIR_CREDENTIALS_KEY);
  const migrated = await migrateLegacyCredentials(app.get<BrigadirDb>(DRIZZLE), key);
  if (migrated > 0) {
    logger.log(`re-encrypted ${migrated} legacy credential blob(s) to AES-256-GCM`);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`BRIGADIR backend listening on :${port}`);
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[backend] fatal: ${message}\n`);
  process.exit(1);
});

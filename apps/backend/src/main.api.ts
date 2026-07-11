import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { runMigrations } from '@brigadir/database';
import { loadAgentsConfig, ConfigSeeder } from '@brigadir/app-config';
import { BackendAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('backend');

  // 1. Fail-fast config validation BEFORE anything else — no DB required, so a
  //    broken agents.yaml aborts with a path-qualified error and no partial boot
  //    (T015 / FR-013).
  loadAgentsConfig();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  // 2. Apply committed migrations before the app (and /health) come up (T012).
  await runMigrations(databaseUrl);

  const app = await NestFactory.create(BackendAppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  // 3. Seed workspace/executors/agents from the validated yaml (T017), idempotent.
  await app.get(ConfigSeeder).seed();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`BRIGADIR backend listening on :${port}`);
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[backend] fatal: ${message}\n`);
  process.exit(1);
});

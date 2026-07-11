import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('worker');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: false,
  });
  // On SIGTERM/SIGINT, @nestjs/bullmq closes each Worker (worker.close() waits
  // for in-flight handlers to settle) — graceful shutdown within the process
  // manager's stop_grace_period (research D8).
  app.enableShutdownHooks();
  logger.log('BRIGADIR worker started — consuming run.mock + reconcile');
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[worker] fatal: ${message}\n`);
  process.exit(1);
});

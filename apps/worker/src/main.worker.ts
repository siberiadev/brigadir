import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('worker');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();
  logger.log('BRIGADIR worker started');
}

void bootstrap();

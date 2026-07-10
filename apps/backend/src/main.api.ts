import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { BackendAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('backend');
  const app = await NestFactory.create(BackendAppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`BRIGADIR backend listening on :${port}`);
}

void bootstrap();

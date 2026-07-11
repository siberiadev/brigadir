import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { AppConfigModule } from '@brigadir/app-config';
import { HealthModule } from './health/health.module';

@Module({
  imports: [DatabaseModule.forRoot(), AppConfigModule, HealthModule],
  controllers: [],
  providers: [],
})
export class BackendAppModule {}

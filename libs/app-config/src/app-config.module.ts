import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { agentsConfigProvider, AGENTS_CONFIG } from './agents-config.provider';
import { ConfigSeeder } from './config-seeder';

/**
 * AppConfigModule — loads+validates agents.yaml (fail-fast) and exposes the
 * validated config plus the yaml→DB seeder. Imported by the backend (which
 * seeds on boot) and available to the worker for the loaded executor set.
 */
@Module({
  imports: [DatabaseModule.forRoot()],
  providers: [agentsConfigProvider, ConfigSeeder],
  exports: [AGENTS_CONFIG, ConfigSeeder],
})
export class AppConfigModule {}

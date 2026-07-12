import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { agentsConfigProvider, AGENTS_CONFIG } from './agents-config.provider';
import { ConfigSeeder } from './config-seeder';
import { jwtSecretProvider, BRIGADIR_JWT_SECRET } from './jwt-secret.provider';

/**
 * AppConfigModule — loads+validates agents.yaml (fail-fast) and exposes the
 * validated config plus the yaml→DB seeder. Imported by the backend (which
 * seeds on boot) and available to the worker for the loaded executor set.
 * Also exposes BRIGADIR_JWT_SECRET (feature 004) — resolved lazily in its own
 * factory, same posture as AGENTS_CONFIG.
 */
@Module({
  imports: [DatabaseModule.forRoot()],
  providers: [agentsConfigProvider, ConfigSeeder, jwtSecretProvider],
  exports: [AGENTS_CONFIG, ConfigSeeder, BRIGADIR_JWT_SECRET],
})
export class AppConfigModule {}

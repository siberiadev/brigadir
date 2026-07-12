import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { DatabaseModule } from '@brigadir/database';
import { AppConfigModule } from '@brigadir/app-config';
import { QueuesModule } from '@brigadir/queues';
import { JiraModule } from '@brigadir/jira';
import { CallbackModule } from '@brigadir/callback';
import { HealthModule } from './health/health.module';
import { DashboardModule } from './dashboard/dashboard.module';

/**
 * Backend composition. Feature 004 additive: QueuesModule.register() — NOT
 * optional here: ResumeService (resolve endpoint) enqueues the new attempt's
 * BullMQ job from THIS process (the resume HTTP surface lives on the
 * backend). CallbackService's job.updateProgress() best-effort hook piggybacks
 * on the same queue providers. JiraModule.forRootAsync() (@Global, LAZY —
 * HumanTasksModule/PipelineModule need JIRA_CLIENT, resolved from the DB row
 * on first use, never at boot).
 *
 * Feature 005: DashboardModule adds the guarded `/api/workspaces*` + `/api/agents*`
 * REST surface. ServeStaticModule serves the built SPA (`apps/web/dist`) at `/`
 * with SPA fallback, EXCLUDING `/api/*` and `/health` so those always route to
 * their controllers (never shadowed). The dist path is read lazily (forRootAsync)
 * and tolerates a missing directory (dist may not be built yet).
 */
@Module({
  imports: [
    DatabaseModule.forRoot(),
    AppConfigModule,
    QueuesModule.register(),
    JiraModule.forRootAsync(),
    CallbackModule,
    HealthModule,
    DashboardModule,
    ServeStaticModule.forRootAsync({
      useFactory: () => [
        {
          rootPath: process.env.WEB_DIST_PATH ?? join(process.cwd(), 'apps', 'web', 'dist'),
          // `/api/*` and `/health` must never be shadowed by the SPA fallback.
          exclude: ['/api/{*splat}', '/health'],
        },
      ],
    }),
  ],
  controllers: [],
  providers: [],
})
export class BackendAppModule {}

import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { DatabaseModule } from '@brigadir/database';
import { AppConfigModule } from '@brigadir/app-config';
import { QueuesModule } from '@brigadir/queues';
import { JiraModule } from '@brigadir/jira';
import { CallbackModule } from '@brigadir/callback';
import { HealthModule } from './health/health.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SpaFallbackProvider, resolveWebDistPath } from './spa-fallback.provider';

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
 * REST surface. ServeStaticModule serves the built SPA's ASSETS (`apps/web/dist`)
 * at `/`; the client-route fallback to index.html is OURS (SpaFallbackProvider) —
 * the module's own renderPath fallback sendFile()s without a `root` option and
 * express's dotfiles policy then 404s any install whose absolute path contains a
 * dot directory (e.g. `.claude/worktrees/…`), so it is parked on a never-matching
 * path. `/api/*` and `/health` always route to their controllers (never
 * shadowed). The dist path is read lazily (forRootAsync / onModuleInit) and
 * tolerates a missing directory (dist may not be built yet).
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
          rootPath: resolveWebDistPath(),
          // `/api/*` and `/health` must never be shadowed by the SPA fallback.
          exclude: ['/api/{*splat}', '/health'],
          // Park the module's OWN index.html fallback on a path no client
          // route uses: its renderFn sendFile()s without `root` and breaks
          // under dot-directory install paths — SpaFallbackProvider owns the
          // fallback instead (see its doc comment).
          renderPath: '/__spa-fallback-disabled',
        },
      ],
    }),
  ],
  controllers: [],
  providers: [SpaFallbackProvider],
})
export class BackendAppModule {}

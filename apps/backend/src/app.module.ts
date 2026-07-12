import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { AppConfigModule } from '@brigadir/app-config';
import { QueuesModule } from '@brigadir/queues';
import { JiraModule } from '@brigadir/jira';
import { CallbackModule } from '@brigadir/callback';
import { HealthModule } from './health/health.module';

/**
 * Backend composition. Feature 004 additive: QueuesModule.register() — NOT
 * optional here: ResumeService (resolve endpoint) enqueues the new attempt's
 * BullMQ job from THIS process (the resume HTTP surface lives on the
 * backend). CallbackService's job.updateProgress() best-effort hook piggybacks
 * on the same queue providers. JiraModule.forRootAsync() (@Global, LAZY —
 * HumanTasksModule/PipelineModule need JIRA_CLIENT, resolved from the DB row
 * on first use, never at boot).
 */
@Module({
  imports: [
    DatabaseModule.forRoot(),
    AppConfigModule,
    QueuesModule.register(),
    JiraModule.forRootAsync(),
    CallbackModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class BackendAppModule {}

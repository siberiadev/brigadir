import { Module } from '@nestjs/common';
import { dashboardTokenProvider, DashboardTokenGuard } from '@brigadir/app-config';
import { HumanTaskService } from './human-task.service';
import { ResumeService } from './resume.service';
import { ResolveController } from './resolve.controller';

/**
 * HumanTaskModule — human-task creation/dedup + park/transition (FR-012/014/
 * 015/020) and resolve/resume (FR-016-019). Relies on the globally-provided
 * DRIZZLE (DatabaseModule), JIRA_CLIENT (JiraModule.forRootAsync, @Global),
 * and the `run.<type>` queue providers (QueuesModule.register(), @Global).
 */
@Module({
  controllers: [ResolveController],
  // Feature 006: `dashboardTokenProvider` + guard resolve the shared bearer for
  // the now-guarded resolve endpoint (BRIGADIR_DASHBOARD_TOKEN, fail-fast).
  providers: [HumanTaskService, ResumeService, dashboardTokenProvider, DashboardTokenGuard],
  exports: [HumanTaskService, ResumeService],
})
export class HumanTasksModule {}

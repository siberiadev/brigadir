import { Module } from '@nestjs/common';
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
  providers: [HumanTaskService, ResumeService],
  exports: [HumanTaskService, ResumeService],
})
export class HumanTasksModule {}

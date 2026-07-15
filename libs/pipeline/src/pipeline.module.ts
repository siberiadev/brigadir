import { Module } from '@nestjs/common';
import { RunsModule } from '@brigadir/runs';
import { HumanTasksModule } from '@brigadir/human-tasks';
import { PipelineService } from './pipeline.service';

/**
 * PipelineModule — the status machine (onStatusChanged + onRunFinished).
 *
 * Relies on the globally-provided DRIZZLE (DatabaseModule) and JIRA_CLIENT
 * (JiraModule.forRootAsync is @Global); imports RunsModule for RunTriggerService.
 * Exports PipelineService for the RunProcessor (onRunFinished) and IngestModule
 * (onStatusChanged / onRunFinished from reconcile).
 */
@Module({
  imports: [RunsModule, HumanTasksModule],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}

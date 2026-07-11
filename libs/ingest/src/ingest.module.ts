import { Module } from '@nestjs/common';
import { RunsModule } from '@brigadir/runs';
import { PipelineModule } from '@brigadir/pipeline';
import { PollerService } from './poller.service';
import { WatchdogService } from './watchdog.service';
import { DriftRepairService } from './drift-repair.service';
import { ReconcileService } from './reconcile.service';

/**
 * IngestModule — the reconcile job (poll & diff, dependency re-eval, watchdog,
 * drift repair). Relies on the global DRIZZLE + JIRA_CLIENT + WorkspaceConnectionService
 * (JiraModule.forRootAsync is @Global); imports RunsModule (RunTriggerService,
 * RunsService) and PipelineModule (onStatusChanged / onRunFinished). Exports
 * ReconcileService for the worker's ReconcileProcessor.
 */
@Module({
  imports: [RunsModule, PipelineModule],
  providers: [PollerService, WatchdogService, DriftRepairService, ReconcileService],
  exports: [ReconcileService, PollerService, WatchdogService, DriftRepairService],
})
export class IngestModule {}

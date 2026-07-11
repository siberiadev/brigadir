import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { QueuesModule } from '@brigadir/queues';
import { ExecutorsModule } from '@brigadir/executors';
import { RunsModule } from '@brigadir/runs';
import { JiraModule } from '@brigadir/jira';
import { PipelineModule } from '@brigadir/pipeline';
import { IngestModule } from '@brigadir/ingest';
import { ReconcileProcessor } from './reconcile.processor';
import { ReconcileScheduler } from './reconcile.scheduler';
import { RunProcessor } from './run.processor';

/**
 * Worker composition. JiraModule.forRootAsync() is @Global and LAZY — it exposes
 * JIRA_CLIENT app-wide without reading credentials at boot (credential-free boot;
 * the reconcile pass resolves the client on first use). PipelineModule drives the
 * run→Jira write; IngestModule owns the reconcile job.
 */
@Module({
  imports: [
    DatabaseModule.forRoot(),
    QueuesModule.register(),
    ExecutorsModule,
    RunsModule,
    JiraModule.forRootAsync(),
    PipelineModule,
    IngestModule,
  ],
  providers: [RunProcessor, ReconcileProcessor, ReconcileScheduler],
})
export class WorkerAppModule {}

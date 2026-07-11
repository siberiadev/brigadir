import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { QueuesModule } from '@brigadir/queues';
import { ExecutorsModule } from '@brigadir/executors';
import { RunsModule } from '@brigadir/runs';
import { ReconcileProcessor } from './reconcile.processor';
import { ReconcileScheduler } from './reconcile.scheduler';
import { RunProcessor } from './run.processor';

@Module({
  imports: [DatabaseModule.forRoot(), QueuesModule.register(), ExecutorsModule, RunsModule],
  providers: [RunProcessor, ReconcileProcessor, ReconcileScheduler],
})
export class WorkerAppModule {}

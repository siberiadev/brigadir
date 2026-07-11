import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { QueuesModule } from '@brigadir/queues';
import { RunsModule } from '@brigadir/runs';

/** Minimal context that can trigger a run (no processor — the worker consumes). */
@Module({
  imports: [DatabaseModule.forRoot(), QueuesModule.register(), RunsModule],
})
export class SmokeModule {}

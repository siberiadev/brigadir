import { Module } from '@nestjs/common';
import { RunTriggerService } from './run-trigger.service';
import { RunsService } from './runs.service';

/**
 * RunsModule — run lifecycle services (trigger + state machine). Relies on the
 * globally-registered DatabaseModule (DRIZZLE) and QueuesModule (queue providers).
 */
@Module({
  providers: [RunTriggerService, RunsService],
  exports: [RunTriggerService, RunsService],
})
export class RunsModule {}

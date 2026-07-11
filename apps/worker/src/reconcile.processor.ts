import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { RECONCILE_QUEUE } from '@brigadir/queues';
import { ReconcileService } from '@brigadir/ingest';

/**
 * Reconcile sweeper (spec FR-010, closes F3). Delegates to
 * `ReconcileService.run()` — one pass of the four ordered steps (poll & diff,
 * dependency re-eval, watchdog, drift repair). The iteration-1 no-op is gone.
 */
@Processor(RECONCILE_QUEUE)
export class ReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconcileProcessor.name);

  constructor(private readonly reconcile: ReconcileService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`reconcile tick (job ${job.id ?? 'scheduled'})`);
    await this.reconcile.run();
  }
}

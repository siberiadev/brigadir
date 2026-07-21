import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { OUTBOX_RECONCILE_QUEUE } from '@brigadir/queues';
import { OutboxReconcileService } from './outbox-reconcile.service';

/**
 * Periodic outbox-reconcile job (feature 026, US3). Delegates one scan pass to
 * `OutboxReconcileService.run()`. Scheduled by `OutboxReconcileScheduler`.
 */
@Processor(OUTBOX_RECONCILE_QUEUE)
export class OutboxReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxReconcileProcessor.name);

  constructor(private readonly reconcile: OutboxReconcileService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`outbox-reconcile tick (job ${job.id ?? 'scheduled'})`);
    await this.reconcile.run();
  }
}

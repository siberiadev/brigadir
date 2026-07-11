import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { RECONCILE_QUEUE } from '@brigadir/queues';

/**
 * Reconcile sweeper (research F3 / spec FR-010). Iteration 1 is a scheduled
 * no-op: it logs one event and performs no side effects. The three real duties
 * (poll Jira, repair run↔queue drift, webhook refresh) arrive in iteration 2.
 */
@Processor(RECONCILE_QUEUE)
export class ReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconcileProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(`reconcile tick (job ${job.id ?? 'scheduled'}) — no-op`);
  }
}

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RECONCILE_QUEUE } from '@brigadir/queues';

/**
 * Registers the reconcile job scheduler on worker bootstrap (research D3).
 * `upsertJobScheduler` is idempotent by scheduler id, so repeated boots /
 * restarts never create a second schedule (spec FR-010, tested in T020).
 */
@Injectable()
export class ReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconcileScheduler.name);

  constructor(@InjectQueue(RECONCILE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler('reconcile', { every: 300_000 });
    this.logger.log('reconcile scheduler upserted (every 300000ms)');
  }
}

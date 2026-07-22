import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RECONCILE_QUEUE } from '@brigadir/queues';

/** Default reconcile cadence; override via BRIGADIR_RECONCILE_EVERY_MS. */
const RECONCILE_EVERY_MS = 30_000;

/**
 * Registers the reconcile job scheduler on worker bootstrap (research D3).
 * `upsertJobScheduler` is idempotent by scheduler id, so repeated boots /
 * restarts never create a second schedule (spec FR-010, tested in T020);
 * a changed cadence updates the existing schedule in place.
 */
@Injectable()
export class ReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconcileScheduler.name);

  constructor(@InjectQueue(RECONCILE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    const every = Number(process.env.BRIGADIR_RECONCILE_EVERY_MS) || RECONCILE_EVERY_MS;
    await this.queue.upsertJobScheduler('reconcile', { every });
    this.logger.log(`reconcile scheduler upserted (every ${every}ms)`);
  }
}

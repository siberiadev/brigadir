import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OUTBOX_RECONCILE_QUEUE } from '@brigadir/queues';

/** Default periodic outbox-reconcile cadence (feature 026, Clarification Q4). */
const OUTBOX_RECONCILE_EVERY_MS = 60_000;

/**
 * Registers the outbox-reconcile job scheduler on worker bootstrap (feature
 * 026, US3 — mirrors ReconcileScheduler). `upsertJobScheduler` is idempotent
 * by scheduler id, so repeated boots / restarts never create a second
 * schedule.
 */
@Injectable()
export class OutboxReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxReconcileScheduler.name);

  constructor(@InjectQueue(OUTBOX_RECONCILE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    const every = Number(process.env.BRIGADIR_OUTBOX_RECONCILE_EVERY_MS) || OUTBOX_RECONCILE_EVERY_MS;
    await this.queue.upsertJobScheduler('outbox-reconcile', { every });
    this.logger.log(`outbox-reconcile scheduler upserted (every ${every}ms)`);
  }
}

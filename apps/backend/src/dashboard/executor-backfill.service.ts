import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DRIZZLE, type BrigadirDb } from '@brigadir/database';
import { backfillDefaultExecutors } from './executor-seed';

/**
 * Type-scoped executor backfill (feature 006, executors-api.md "Backfill").
 * Runs once at backend bootstrap so a workspace created before this feature
 * with zero executors of a type is seeded that type's default — FR-023's
 * "never present an empty list" holds for every workspace, not only post-006
 * ones. Idempotent and type-scoped (see `backfillDefaultExecutors`), so repeated
 * boots never duplicate defaults or inflate the per-type concurrency sum.
 */
@Injectable()
export class ExecutorBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExecutorBackfillService.name);

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<void> {
    try {
      await backfillDefaultExecutors(this.db);
    } catch (err) {
      // Non-fatal: a backfill hiccup must never fail backend boot.
      this.logger.error(`executor backfill failed (non-fatal): ${String(err)}`);
    }
  }
}

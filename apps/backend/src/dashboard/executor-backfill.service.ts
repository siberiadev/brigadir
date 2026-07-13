import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DRIZZLE, type BrigadirDb } from '@brigadir/database';
import { backfillDefaultExecutors } from './executor-seed';

/**
 * Type-scoped executor backfill, PLATFORM-scoped (2026-07-13). Runs once at
 * backend bootstrap so a DB with zero executors of a type is seeded that
 * type's global default — the agent-form picker is never empty, and workspace
 * creation no longer seeds anything. Idempotent and type-scoped (see
 * `backfillDefaultExecutors`), so repeated boots never duplicate defaults or
 * inflate the per-type concurrency sum.
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

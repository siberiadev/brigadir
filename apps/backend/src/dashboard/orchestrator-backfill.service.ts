import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DRIZZLE, type BrigadirDb, schema, seedOrchestratorAgent } from '@brigadir/database';

/**
 * Orchestrator backfill (feature 010, FR-018, D10). Runs once at backend
 * bootstrap so every EXISTING workspace gains a "brigadir" orchestrator (and the
 * shared cheap no-repo executor profile) — new workspaces are seeded at creation
 * (wizard / yaml). Insert-if-absent, so repeated boots never duplicate and an
 * operator-edited orchestrator is never overwritten. Non-fatal on error.
 */
@Injectable()
export class OrchestratorBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrchestratorBackfillService.name);

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<void> {
    try {
      const workspaces = await this.db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces);
      let created = 0;
      for (const ws of workspaces) {
        const result = await seedOrchestratorAgent(this.db, ws.id);
        if (result.created) created += 1;
      }
      if (created > 0) {
        this.logger.log(`orchestrator backfill: seeded ${created} workspace(s)`);
      }
    } catch (err) {
      // Non-fatal: a backfill hiccup must never fail backend boot.
      this.logger.error(`orchestrator backfill failed (non-fatal): ${String(err)}`);
    }
  }
}

import { Injectable, Inject, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { type JiraClient, JiraClientFactory, WorkspaceConnectionService } from '@brigadir/jira';
import { DependencyReleaseService } from '@brigadir/pipeline';
import type { JiraBoardType } from '@brigadir/contracts';
import { PollerService, type WorkspaceContext } from './poller.service';
import { WatchdogService } from './watchdog.service';
import { DriftRepairService } from './drift-repair.service';

/**
 * ReconcileService (contracts.md C7 / research D7). One pass = four ordered
 * steps, each wrapped in its own try/catch so a failing step logs and continues
 * (never starves the rest). All Jira-bound steps share ONE pass-level Jira
 * budget — the single lazy JiraClient's global token-bucket + concurrency cap
 * serialize every Jira call across the steps.
 *
 * Steps: watchdog (global, Jira-free, includes the queued sweep) → then
 * per-workspace: poll & diff → dependency re-eval → drift repair.
 *
 * Feature 034: the watchdog is a pure-DB reaper and runs FIRST, before any
 * Jira client resolution — a credential-decode failure or board-introspection
 * outage must never starve run finalization (the 17h-Reviewer incident: a
 * workspace-level Jira failure silently disabled its watchdog).
 *
 * Board introspection is wired here LAZILY (closing the phase-1-3 deviation):
 * boot stays credential-free; at the START of a pass, if `jira_board_type` is
 * NULL the board is introspected once via the Agile API and persisted. On
 * introspection failure the workspace is skipped with a logged diagnostic (the
 * worker does not crash and does not busy-retry faster than the reconcile
 * interval).
 *
 * Multi-workspace (feature 006, US5): ONE pass processes EVERY enabled workspace
 * (`settings.enabled` absent or not `false`) with its OWN per-workspace Jira
 * client (`JiraClientFactory.forWorkspace`, resolved lazily at pass time — never
 * at composition) and its own board scope / HWM. A per-workspace try/catch plus
 * the existing per-step try/catch give two isolation layers: a Jira outage or
 * credential-decode failure in one workspace never aborts the others (FR-029).
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly jiraFactory: JiraClientFactory,
    private readonly connection: WorkspaceConnectionService,
    private readonly poller: PollerService,
    private readonly watchdog: WatchdogService,
    private readonly drift: DriftRepairService,
    private readonly release: DependencyReleaseService,
  ) {}

  async run(): Promise<void> {
    // Jira-free and workspace-independent — must run even when every
    // workspace is disabled or every Jira credential is broken.
    await this.step('watchdog', () => this.watchdog.sweepAll());

    const workspaces = await this.db
      .select({
        id: schema.workspaces.id,
        projectKey: schema.workspaces.jiraProjectKey,
        boardId: schema.workspaces.jiraBoardId,
        boardType: schema.workspaces.jiraBoardType,
      })
      .from(schema.workspaces)
      // R3: `enabled` lives in the settings jsonb; ABSENT ⇒ enabled. A disabled
      // workspace (`settings.enabled === false`) is not selected → skipped
      // entirely (FR-028).
      .where(sql`${schema.workspaces.settings}->>'enabled' is distinct from 'false'`);

    if (workspaces.length === 0) {
      this.logger.log('reconcile: no enabled workspace configured — nothing to do');
      return;
    }

    for (const wsRow of workspaces) {
      // FR-029: per-workspace isolation — client resolution / board
      // introspection / any step throwing for THIS workspace is logged and the
      // workspace is skipped for this pass; the others still complete.
      try {
        const jira = await this.jiraFactory.forWorkspace(wsRow.id);
        const boardType = await this.ensureBoardType(
          wsRow.id,
          wsRow.boardType as JiraBoardType | null,
          jira,
        );
        if (!boardType) continue; // introspection failed → skip this ws only

        const ws: WorkspaceContext = {
          id: wsRow.id,
          projectKey: wsRow.projectKey,
          boardId: wsRow.boardId,
          boardType,
        };

        await this.step('poll & diff', () => this.poller.pollAndDiff(ws, jira));
        await this.step('dependency re-eval', () => this.reEvaluateDependencies(ws, jira));
        await this.step('drift repair', () => this.drift.repair(ws));
      } catch (err) {
        this.logger.error(
          `workspace ${wsRow.id}: reconcile pass failed (others continue): ${String(err)}`,
        );
        continue;
      }
    }
  }

  /**
   * Dependency re-evaluation (contracts.md C7 step 2 / FR-036). Feature 022:
   * the pass body lives in `DependencyReleaseService` (libs/pipeline) so the
   * post-success fast path shares the exact fetch→gate→order→trigger code; this
   * method stays as the reconcile-facing seam (and the test surface).
   */
  async reEvaluateDependencies(ws: WorkspaceContext, jira: JiraClient): Promise<void> {
    await this.release.releaseFor(ws, jira);
  }

  private async ensureBoardType(
    workspaceId: string,
    current: JiraBoardType | null,
    jira: JiraClient,
  ): Promise<JiraBoardType | null> {
    if (current) return current;
    try {
      return await this.connection.introspectAndPersistBoardType(workspaceId, jira);
    } catch (err) {
      this.logger.error(
        `workspace ${workspaceId}: board introspection failed — skipping this reconcile pass (retry next interval): ${String(err)}`,
      );
      return null;
    }
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`reconcile step "${name}" failed (other steps continue): ${String(err)}`);
    }
  }
}

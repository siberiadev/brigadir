import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JIRA_CLIENT, type JiraClient, WorkspaceConnectionService } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { evaluateDependencyGate, buildAgentTriggerEvent } from '@brigadir/pipeline';
import type { JiraBoardType } from '@brigadir/contracts';
import { PollerService, type WorkspaceContext } from './poller.service';
import { WatchdogService } from './watchdog.service';
import { DriftRepairService } from './drift-repair.service';
import { POLL_FIELDS } from './scope-jql';

/**
 * ReconcileService (contracts.md C7 / research D7). One pass = four ordered
 * steps, each wrapped in its own try/catch so a failing step logs and continues
 * (never starves the rest). All steps share ONE pass-level Jira budget — the
 * single lazy JiraClient's global token-bucket + concurrency cap serialize every
 * Jira call across the steps.
 *
 * Steps: poll & diff → dependency re-eval → watchdog → drift repair.
 *
 * Board introspection is wired here LAZILY (closing the phase-1-3 deviation):
 * boot stays credential-free; at the START of a pass, if `jira_board_type` is
 * NULL the board is introspected once via the Agile API and persisted. On
 * introspection failure the pass is skipped with a logged diagnostic (the worker
 * does not crash and does not busy-retry faster than the reconcile interval).
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(JIRA_CLIENT) private readonly jira: JiraClient,
    private readonly connection: WorkspaceConnectionService,
    private readonly poller: PollerService,
    private readonly watchdog: WatchdogService,
    private readonly drift: DriftRepairService,
    private readonly runTrigger: RunTriggerService,
  ) {}

  async run(): Promise<void> {
    const [wsRow] = await this.db
      .select({
        id: schema.workspaces.id,
        projectKey: schema.workspaces.jiraProjectKey,
        boardId: schema.workspaces.jiraBoardId,
        boardType: schema.workspaces.jiraBoardType,
      })
      .from(schema.workspaces)
      .limit(1);
    if (!wsRow) {
      this.logger.log('reconcile: no workspace configured — nothing to do');
      return;
    }

    const boardType = await this.ensureBoardType(wsRow.id, wsRow.boardType as JiraBoardType | null);
    if (!boardType) return; // introspection failed → skip this pass, retry next interval

    const ws: WorkspaceContext = {
      id: wsRow.id,
      projectKey: wsRow.projectKey,
      boardId: wsRow.boardId,
      boardType,
    };

    await this.step('poll & diff', () => this.poller.pollAndDiff(ws));
    await this.step('dependency re-eval', () => this.reEvaluateDependencies(ws));
    await this.step('watchdog', () => this.watchdog.sweep(ws));
    await this.step('drift repair', () => this.drift.repair(ws));
  }

  /**
   * Dependency re-evaluation (contracts.md C7 step 2 / FR-036). For tickets
   * currently sitting in some enabled agent's `trigger_status` with NO
   * active/succeeded run for that agent, fetch the current issue links, re-check
   * the gate, and trigger (via RunTriggerService → three dedup layers) when now
   * clear — independent of the HWM floor, since resolving a blocker changes only
   * the blocker's `updated`.
   */
  async reEvaluateDependencies(ws: WorkspaceContext): Promise<void> {
    const candidates = await this.db
      .select({
        ticketId: schema.tickets.id,
        ticketKey: schema.tickets.jiraKey,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        behavior: schema.agents.behavior,
      })
      .from(schema.tickets)
      .innerJoin(
        schema.agents,
        and(
          eq(schema.agents.workspaceId, schema.tickets.workspaceId),
          eq(schema.agents.triggerStatus, schema.tickets.lastSeenStatus),
          eq(schema.agents.enabled, true),
        ),
      )
      .where(
        and(
          eq(schema.tickets.workspaceId, ws.id),
          sql`not exists (
            select 1 from ${schema.runs}
            where ${schema.runs.ticketId} = ${schema.tickets.id}
              and ${schema.runs.agentId} = ${schema.agents.id}
              and ${schema.runs.status} in ('queued', 'running', 'awaiting_human', 'succeeded')
          )`,
        ),
      );
    if (candidates.length === 0) return;

    const keys = [...new Set(candidates.map((c) => c.ticketKey))];
    const jql = `project = "${ws.projectKey}" AND key in (${keys.join(', ')})`;
    const issues = await this.jira.searchUpdated(jql, [...POLL_FIELDS]);
    const byKey = new Map(issues.map((i) => [i.key, i]));

    for (const c of candidates) {
      const issue = byKey.get(c.ticketKey);
      if (!issue) continue;
      if (evaluateDependencyGate(issue) !== 'clear') continue;

      const res = await this.runTrigger.trigger({
        ticketId: c.ticketId,
        agentId: c.agentId,
        triggerEvent: buildAgentTriggerEvent('poller', c.behavior),
      });
      if (!res.deduplicated) {
        this.logger.log(
          `dependency re-eval: ${c.ticketKey} now clear for "${c.agentName}" → run ${res.runId}`,
        );
      }
    }
  }

  private async ensureBoardType(
    workspaceId: string,
    current: JiraBoardType | null,
  ): Promise<JiraBoardType | null> {
    if (current) return current;
    try {
      return await this.connection.introspectAndPersistBoardType(workspaceId);
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

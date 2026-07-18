import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { type JiraClient, JiraClientFactory, WorkspaceConnectionService, POLL_FIELDS } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { evaluateDependencyGate, buildAgentTriggerEvent } from '@brigadir/pipeline';
import type { JiraBoardType } from '@brigadir/contracts';
import { PollerService, type WorkspaceContext } from './poller.service';
import { WatchdogService } from './watchdog.service';
import { DriftRepairService } from './drift-repair.service';

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
    private readonly runTrigger: RunTriggerService,
  ) {}

  async run(): Promise<void> {
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
        await this.step('watchdog', () => this.watchdog.sweep(ws));
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
   * Dependency re-evaluation (contracts.md C7 step 2 / FR-036). For tickets
   * currently sitting in some enabled agent's `trigger_status` with NO
   * active/succeeded run for that agent, fetch the current issue links, re-check
   * the gate, and trigger (via RunTriggerService → three dedup layers) when now
   * clear — independent of the HWM floor, since resolving a blocker changes only
   * the blocker's `updated`.
   */
  async reEvaluateDependencies(ws: WorkspaceContext, jira: JiraClient): Promise<void> {
    const candidates = await this.db
      .select({
        ticketId: schema.tickets.id,
        ticketKey: schema.tickets.jiraKey,
        agentId: schema.agents.id,
        // feature 014: logs use the key (the readable technical handle), not the persona.
        agentKey: schema.agents.key,
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
    const issues = await jira.searchUpdated(jql, [...POLL_FIELDS]);
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
          `dependency re-eval: ${c.ticketKey} now clear for "${c.agentKey}" → run ${res.runId}`,
        );
      }
    }
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

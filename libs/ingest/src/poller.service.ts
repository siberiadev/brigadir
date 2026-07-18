import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getScopeJql,
  getReconcileState,
  setReconcileState,
} from '@brigadir/database';
import { type JiraClient, POLL_FIELDS, buildScopeJql, sinceClause, parseJiraPriority } from '@brigadir/jira';
import { PipelineService } from '@brigadir/pipeline';
import type { JiraBoardType, JiraIssue } from '@brigadir/contracts';

/** Resolved workspace the reconcile pass operates on. */
export interface WorkspaceContext {
  id: string;
  projectKey: string;
  boardId: number | null;
  boardType: JiraBoardType;
}

/**
 * Poller (contracts.md C7 step 1 / research D7, D9). Builds the board-type scope
 * JQL (+ optional `scope_jql` + HWM overlap), pages `nextPageToken`, upserts
 * tickets, diffs `last_seen_status` → `PipelineService.onStatusChanged`
 * (scope-entry when `last_seen_status` is absent, FR-031), handles the
 * sprint-switch full rescan (D9), and advances + persists the high-water mark.
 *
 * `last_seen_status` is a diff cache only (Principle I) — Jira remains the source
 * of truth; a per-ticket trigger failure is logged and the cache is left
 * unadvanced so the next pass retries (the three dedup layers keep it exactly-once).
 */
@Injectable()
export class PollerService {
  private readonly logger = new Logger(PollerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly pipeline: PipelineService,
  ) {}

  /**
   * `jira` (feature 006, US5) is the per-workspace client the reconcile loop
   * resolves for THIS workspace — the poller no longer injects the global
   * `JIRA_CLIENT` (which resolved `workspaces LIMIT 1`).
   */
  async pollAndDiff(ws: WorkspaceContext, jira: JiraClient): Promise<void> {
    const scopeJql = await getScopeJql(this.db, ws.id);
    const { highWaterMark, activeSprintId } = await getReconcileState(this.db, ws.id);

    if (ws.boardType === 'scrum') {
      const currentSprintId = ws.boardId != null ? await jira.getActiveSprintId(ws.boardId) : null;

      if (currentSprintId == null) {
        // No active sprint → idle no-op (FR-030); remember the absence.
        if (activeSprintId != null) await setReconcileState(this.db, ws.id, { activeSprintId: null });
        this.logger.log(`workspace ${ws.id}: scrum board has no active sprint — poll idle`);
        return;
      }

      if (currentSprintId !== activeSprintId) {
        // Sprint switch (FR-032): one-off FULL rescan of the new sprint WITHOUT
        // the `updated` clause — a sprint start does not touch issues' `updated`.
        const jql = buildScopeJql({
          boardType: 'scrum',
          projectKey: ws.projectKey,
          sprintId: currentSprintId,
          scopeJql,
        });
        const issues = await jira.searchUpdated(jql, [...POLL_FIELDS]);
        const maxUpdated = await this.processIssues(ws, issues);
        await setReconcileState(this.db, ws.id, {
          activeSprintId: currentSprintId,
          highWaterMark: maxUpdated ?? highWaterMark,
        });
        this.logger.log(
          `workspace ${ws.id}: sprint switch → rescanned ${issues.length} issue(s) of sprint ${currentSprintId}`,
        );
        return;
      }

      const jql = buildScopeJql({
        boardType: 'scrum',
        projectKey: ws.projectKey,
        sprintId: currentSprintId,
        scopeJql,
        since: sinceClause(highWaterMark),
      });
      const issues = await jira.searchUpdated(jql, [...POLL_FIELDS]);
      const maxUpdated = await this.processIssues(ws, issues);
      if (maxUpdated) await setReconcileState(this.db, ws.id, { highWaterMark: maxUpdated });
      return;
    }

    // kanban: whole project (+ optional scope_jql), bounded by the HWM overlap.
    const jql = buildScopeJql({
      boardType: 'kanban',
      projectKey: ws.projectKey,
      scopeJql,
      since: sinceClause(highWaterMark),
    });
    const issues = await jira.searchUpdated(jql, [...POLL_FIELDS]);
    const maxUpdated = await this.processIssues(ws, issues);
    if (maxUpdated) await setReconcileState(this.db, ws.id, { highWaterMark: maxUpdated });
  }

  /** Upsert + diff each issue; returns the max observed `updated` (for the HWM). */
  private async processIssues(ws: WorkspaceContext, issues: JiraIssue[]): Promise<string | undefined> {
    let maxUpdated: string | undefined;

    for (const issue of issues) {
      const toStatus = issue.fields.status.name;
      const updatedIso = issue.fields.updated;
      if (!maxUpdated || updatedIso > maxUpdated) maxUpdated = updatedIso;

      const { ticketId, prevStatus } = await this.upsertTicket(ws, issue);

      try {
        if (prevStatus == null) {
          // Scope entry — a ticket first observed already in a trigger status is a trigger (FR-031).
          await this.pipeline.onStatusChanged({
            ticketId,
            issue,
            fromStatus: null,
            toStatus,
            source: 'scope_entry',
          });
        } else if (prevStatus !== toStatus) {
          await this.pipeline.onStatusChanged({
            ticketId,
            issue,
            fromStatus: prevStatus,
            toStatus,
            source: 'poller',
          });
        }
        // Advance the diff cache only after the trigger fired (or was a no-op),
        // so a failure re-processes the same transition next pass.
        await this.db
          .update(schema.tickets)
          .set({
            lastSeenStatus: toStatus,
            lastSeenUpdated: new Date(updatedIso),
            summary: issue.fields.summary,
            ...parseJiraPriority(issue),
          })
          .where(eq(schema.tickets.id, ticketId));
      } catch (err) {
        this.logger.error(
          `workspace ${ws.id}: diff for ${issue.key} (${prevStatus ?? '∅'} → ${toStatus}) failed; will retry next pass: ${String(err)}`,
        );
      }
    }

    return maxUpdated;
  }

  private async upsertTicket(
    ws: WorkspaceContext,
    issue: JiraIssue,
  ): Promise<{ ticketId: string; prevStatus: string | null }> {
    const [existing] = await this.db
      .select({ id: schema.tickets.id, lastSeenStatus: schema.tickets.lastSeenStatus })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.workspaceId, ws.id), eq(schema.tickets.jiraKey, issue.key)))
      .limit(1);

    if (existing) {
      return { ticketId: existing.id, prevStatus: existing.lastSeenStatus };
    }

    const [inserted] = await this.db
      .insert(schema.tickets)
      .values({
        workspaceId: ws.id,
        jiraKey: issue.key,
        jiraId: issue.id,
        summary: issue.fields.summary,
        ...parseJiraPriority(issue),
      })
      .returning({ id: schema.tickets.id });
    return { ticketId: inserted.id, prevStatus: null };
  }
}

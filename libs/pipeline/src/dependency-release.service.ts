import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { type JiraClient, POLL_FIELDS, parseJiraPriority } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import type { JiraBoardType, TriggerEvent } from '@brigadir/contracts';
import { evaluateDependencyGate, blockingKeys } from './dependency-gate';
import type { StatusChangeSource } from './pipeline.service';

/**
 * The workspace slice the release pass needs. Structurally compatible with the
 * ingest `WorkspaceContext` (this lib must not import ingest — ingest imports us).
 */
export interface ReleaseScope {
  id: string;
  projectKey: string;
  boardId: number | null;
  boardType: JiraBoardType;
}

/** One (ticket, agent) release candidate row. */
interface CandidateRow {
  ticketId: string;
  ticketKey: string;
  agentId: string;
  agentKey: string;
  behavior: unknown;
}

/**
 * DependencyReleaseService (feature 022; extracted from
 * `ReconcileService.reEvaluateDependencies`, originally FR-036 of feature 001).
 *
 * The pull-based release guarantee: for tickets currently sitting in some
 * enabled agent's `trigger_status` with NO active/succeeded run for that agent,
 * fetch the current issue links in ONE batched search (independent of the HWM
 * floor — resolving a blocker changes only the blocker's `updated`, never the
 * dependent's), re-check the dependency gate, and trigger the now-clear ones
 * via RunTriggerService (three dedup layers). Feature 022 adds on top:
 *
 * - waiting-state diff cache: `tickets.blocked_by` / `tickets.blocked_state`
 *   kept current every pass (cleared on release; Principle I: cache, never truth);
 * - `releaseDependentsOf` — the post-success fast path (FR-003 SHOULD), same
 *   code path narrowed to the finished blocker's dependents.
 */
@Injectable()
export class DependencyReleaseService {
  private readonly logger = new Logger(DependencyReleaseService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runTrigger: RunTriggerService,
  ) {}

  /** Full per-workspace pass — reconcile step 2 delegates here. */
  async releaseFor(ws: ReleaseScope, jira: JiraClient): Promise<void> {
    await this.process(ws, jira, await this.candidates(ws.id));
  }

  /**
   * Fast path (FR-003): release only the dependents of one just-completed
   * blocker. Same fetch→gate→trigger pass, candidate set narrowed to tickets
   * whose cached `blocked_by` contains the blocker's key. The reconcile pass
   * remains the guarantee — a miss here (e.g. cache not yet written) heals on
   * the next pass.
   */
  async releaseDependentsOf(ws: ReleaseScope, jira: JiraClient, blockerKey: string): Promise<void> {
    const candidates = await this.candidates(ws.id, blockerKey);
    if (candidates.length === 0) return;
    this.logger.log(
      `fast path: ${blockerKey} completed → re-checking ${candidates.length} dependent candidate(s)`,
    );
    await this.process(ws, jira, candidates);
  }

  /**
   * (ticket, agent) pairs eligible for release: ticket's last seen status IS an
   * enabled agent's trigger status, and no active/succeeded run exists for the
   * pair. `succeeded` is excluded deliberately (unlike the human re-trigger
   * path): the pass must never re-run finished work it did not observe leaving.
   */
  private async candidates(workspaceId: string, blockedByKey?: string): Promise<CandidateRow[]> {
    return this.db
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
          eq(schema.tickets.workspaceId, workspaceId),
          ...(blockedByKey
            ? [sql`${schema.tickets.blockedBy} @> ${JSON.stringify([blockedByKey])}::jsonb`]
            : []),
          sql`not exists (
            select 1 from ${schema.runs}
            where ${schema.runs.ticketId} = ${schema.tickets.id}
              and ${schema.runs.agentId} = ${schema.agents.id}
              and ${schema.runs.status} in ('queued', 'running', 'awaiting_human', 'succeeded')
          )`,
        ),
      );
  }

  private async process(ws: ReleaseScope, jira: JiraClient, candidates: CandidateRow[]): Promise<void> {
    if (candidates.length === 0) return;

    const keys = [...new Set(candidates.map((c) => c.ticketKey))];
    const jql = `project = "${ws.projectKey}" AND key in (${keys.join(', ')})`;
    const issues = await jira.searchUpdated(jql, [...POLL_FIELDS]);
    const byKey = new Map(issues.map((i) => [i.key, i]));

    for (const c of candidates) {
      const issue = byKey.get(c.ticketKey);
      if (!issue) continue;

      if (evaluateDependencyGate(issue) !== 'clear') {
        // Still blocked: keep the waiting cache current (FR-001) — fresh blocker
        // keys + priority from the fetch we already paid for.
        await this.db
          .update(schema.tickets)
          .set({
            blockedBy: blockingKeys(issue),
            blockedState: 'waiting',
            ...parseJiraPriority(issue),
          })
          .where(eq(schema.tickets.id, c.ticketId));
        continue;
      }

      const res = await this.runTrigger.trigger({
        ticketId: c.ticketId,
        agentId: c.agentId,
        triggerEvent: buildAgentTriggerEvent('poller', c.behavior),
      });
      // Released: the ticket is no longer waiting (FR-001 clear rule).
      await this.db
        .update(schema.tickets)
        .set({ blockedBy: null, blockedState: null, ...parseJiraPriority(issue) })
        .where(eq(schema.tickets.id, c.ticketId));
      if (!res.deduplicated) {
        this.logger.log(
          `dependency re-eval: ${c.ticketKey} now clear for "${c.agentKey}" → run ${res.runId}`,
        );
      }
    }
  }
}

/**
 * Build the trigger event for an agent match. `mock_scenario` is threaded from
 * the agent's `behavior` blob when present so integration tests can drive the
 * full loop to each outcome; real executors ignore it (it stays inert in prod,
 * where agents carry no `mock_scenario`). Lives here (not pipeline.service) so
 * both the status-change path and the release pass build identical events
 * without an import cycle.
 */
export function buildAgentTriggerEvent(source: StatusChangeSource, behavior: unknown): TriggerEvent {
  const b = (behavior ?? {}) as Record<string, unknown>;
  const scenario = typeof b.mock_scenario === 'string' ? b.mock_scenario : undefined;
  return {
    source: source === 'webhook' ? 'webhook' : 'poll',
    ...(scenario ? { mock_scenario: scenario } : {}),
  } as TriggerEvent;
}

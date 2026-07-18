import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema, getScopeJql } from '@brigadir/database';
import { type JiraClient, POLL_FIELDS, buildScopeJql, parseJiraPriority } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { HumanTaskService } from '@brigadir/human-tasks';
import type { BlockedState, JiraBoardType, JiraIssue, TriggerEvent } from '@brigadir/contracts';
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
    // feature 022 (FR-010): out-of-scope blockers raise a run-less human task.
    private readonly humanTasks: HumanTaskService,
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

    // FR-006: deterministic release order — priority (ASC id, NULLS LAST) from
    // the fresh fetch, stable jira_key tiebreak. Sequential await below makes
    // enqueue order = this order.
    const ordered = [...candidates].sort((a, b) =>
      compareReleaseOrder(
        { priorityId: priorityOf(byKey.get(a.ticketKey)), jiraKey: a.ticketKey },
        { priorityId: priorityOf(byKey.get(b.ticketKey)), jiraKey: b.ticketKey },
      ),
    );

    // Still-blocked tickets collected for classification (deduped per ticket —
    // several agents may share a trigger status).
    const waiting = new Map<string, { ticketId: string; issue: JiraIssue; blockers: string[] }>();

    for (const c of ordered) {
      const issue = byKey.get(c.ticketKey);
      if (!issue) continue;

      if (evaluateDependencyGate(issue) !== 'clear') {
        waiting.set(c.ticketKey, { ticketId: c.ticketId, issue, blockers: blockingKeys(issue) });
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

    await this.classifyWaiting(ws, jira, waiting);
  }

  /**
   * Classification of the still-blocked tickets (FR-009/FR-010, research R4):
   * cycle > out_of_scope > dead_end > waiting. Two batched probes over the
   * distinct blocker keys, executed only when the waiting set is non-empty:
   *
   * 1. blocker fetch — `key in (…)` with status+resolution, NO project clause
   *    (cross-project blockers must resolve): resolution set ∧ category ≠ done
   *    ⇒ that blocker is a dead end;
   * 2. scope probe — the workspace scope JQL (sprint for scrum, project for
   *    kanban, + scope_jql filter; NO `since` clause — membership, not recency)
   *    restricted to the blocker keys: absentees are outside the observed scope.
   *
   * Out-of-scope tickets additionally get ONE run-less human task (deduped in
   * HumanTaskService.createTicketBlocked).
   */
  private async classifyWaiting(
    ws: ReleaseScope,
    jira: JiraClient,
    waiting: Map<string, { ticketId: string; issue: JiraIssue; blockers: string[] }>,
  ): Promise<void> {
    if (waiting.size === 0) return;

    const cycleTickets = findCycleTickets(
      new Map([...waiting].map(([key, w]) => [key, w.blockers])),
    );

    const probeKeys = [
      ...new Set(
        [...waiting]
          .filter(([key]) => !cycleTickets.has(key))
          .flatMap(([, w]) => w.blockers),
      ),
    ];
    let deadEndBlockers = new Set<string>();
    let inScopeBlockers = new Set<string>();
    if (probeKeys.length > 0) {
      const keyList = probeKeys.join(', ');
      const fetched = await jira.searchUpdated(`key in (${keyList})`, ['status', 'resolution']);
      deadEndBlockers = new Set(
        fetched
          .filter(
            (b) => b.fields.resolution != null && b.fields.status.statusCategory.key !== 'done',
          )
          .map((b) => b.key),
      );

      // The `key in` clause rides inside the scope_jql parens so the builder's
      // trailing ORDER BY stays syntactically last (the `since` clause is
      // deliberately absent — this is a membership probe).
      const scopeJqlSetting = await getScopeJql(this.db, ws.id);
      const sprintId =
        ws.boardType === 'scrum' && ws.boardId != null ? await jira.getActiveSprintId(ws.boardId) : null;
      const probeJql = buildScopeJql({
        boardType: ws.boardType,
        projectKey: ws.projectKey,
        sprintId,
        scopeJql: scopeJqlSetting ? `(${scopeJqlSetting}) AND key in (${keyList})` : `key in (${keyList})`,
      });
      inScopeBlockers = new Set((await jira.searchUpdated(probeJql, ['status'])).map((b) => b.key));
    }

    for (const [key, w] of waiting) {
      let state: BlockedState = 'waiting';
      if (cycleTickets.has(key)) state = 'cycle';
      else if (w.blockers.some((b) => !inScopeBlockers.has(b))) state = 'out_of_scope';
      else if (w.blockers.some((b) => deadEndBlockers.has(b))) state = 'dead_end';

      await this.db
        .update(schema.tickets)
        .set({ blockedBy: w.blockers, blockedState: state, ...parseJiraPriority(w.issue) })
        .where(eq(schema.tickets.id, w.ticketId));

      if (state === 'cycle') {
        this.logger.warn(
          `sequencing: ${key} is part of a blocked-by CYCLE [${[...cycleTickets].join(', ')}] — no run will start until a human breaks it`,
        );
      } else if (state === 'dead_end') {
        this.logger.warn(
          `sequencing: ${key} waits on a dead-end blocker (resolved outside the done category) — needs human attention`,
        );
      } else if (state === 'out_of_scope') {
        const outside = w.blockers.filter((b) => !inScopeBlockers.has(b));
        this.logger.warn(
          `sequencing: ${key} waits on out-of-scope blocker(s) [${outside.join(', ')}] — raising a human task`,
        );
        await this.humanTasks.createTicketBlocked(ws.id, w.ticketId, {
          title: `${key} is blocked by ticket(s) outside this board's scope`,
          details:
            `${key} sits in a trigger status but waits on [${outside.join(', ')}], which the system does not observe on this board. ` +
            'Bring the blocker(s) into the sprint/board scope, or break the link on the board.',
        });
      }
    }
  }
}

/**
 * Tickets that are members of a blocked-by cycle (FR-009), including
 * self-links. Edges: waiting ticket → its blockers, restricted to keys that
 * are themselves waiting tickets (a blocker outside the waiting set cannot
 * close a cycle through the board's trigger statuses). Iterative
 * three-color DFS; every node on the cycle path is marked.
 */
export function findCycleTickets(edges: Map<string, string[]>): Set<string> {
  const inCycle = new Set<string>();
  const color = new Map<string, 'gray' | 'black'>();
  const stack: string[] = [];

  const visit = (start: string): void => {
    const path: { node: string; nexts: string[] }[] = [
      { node: start, nexts: (edges.get(start) ?? []).filter((n) => edges.has(n)) },
    ];
    color.set(start, 'gray');
    stack.push(start);
    while (path.length > 0) {
      const frame = path[path.length - 1];
      const next = frame.nexts.pop();
      if (next === undefined) {
        color.set(frame.node, 'black');
        stack.pop();
        path.pop();
        continue;
      }
      if (color.get(next) === 'gray') {
        // Back edge: everything from `next` to the stack top is on a cycle.
        for (let i = stack.indexOf(next); i < stack.length; i += 1) inCycle.add(stack[i]);
        continue;
      }
      if (color.get(next) === 'black') continue;
      color.set(next, 'gray');
      stack.push(next);
      path.push({ node: next, nexts: (edges.get(next) ?? []).filter((n) => edges.has(n)) });
    }
  };

  for (const node of edges.keys()) {
    if (!color.has(node)) visit(node);
  }
  return inCycle;
}

/** Ticket slice the release-order comparator reads. */
export interface ReleaseOrderKey {
  priorityId: number | null;
  jiraKey: string;
}

/**
 * Canonical release order (FR-006 / data-model.md §4): priority_id ASC with
 * NULLS LAST (un-prioritized tickets go after prioritized ones), then plain
 * lexicographic jira_key ASC as the stable tiebreak. Used identically by the
 * release loop (in-memory) and the dashboard waiting list (SQL ORDER BY).
 */
export function compareReleaseOrder(a: ReleaseOrderKey, b: ReleaseOrderKey): number {
  if (a.priorityId !== b.priorityId) {
    if (a.priorityId === null) return 1;
    if (b.priorityId === null) return -1;
    return a.priorityId - b.priorityId;
  }
  return a.jiraKey < b.jiraKey ? -1 : a.jiraKey > b.jiraKey ? 1 : 0;
}

function priorityOf(issue: JiraIssue | undefined): number | null {
  return issue ? parseJiraPriority(issue).priorityId : null;
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
